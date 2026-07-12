import { checkStatus } from "./status-correlator";

const AI_GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1/05c934a23d9100d41fc6e9c89ab6cbcb/incidentiq/compat";
const GATEWAY_MODEL = "google-ai-studio/gemini-2.5-flash";
const DIRECT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const DIRECT_GEMINI_MODEL = "gemini-2.5-flash";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = "openai/gpt-4o-mini";
const TIMEOUT_MS = 45000;

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolInvocation {
  tool: string;
  input: object;
  output: object;
}

interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

const STATUS_CORRELATOR_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "status_correlator",
    description:
      "Check the current operational status of a third-party service or provider (e.g., GitHub, Cloudflare, Atlassian, Vercel). Use this when the timeline suggests an external dependency may have caused or contributed to the incident.",
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "The name of the service/provider to check (e.g., 'github', 'cloudflare', 'atlassian', 'vercel')",
        },
      },
      required: ["service"],
    },
  },
};

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function callProvider(
  apiBase: string,
  headers: Record<string, string>,
  model: string,
  messages: LlmMessage[],
  tools: ToolDefinition[],
): Promise<{ content: string | null; tool_calls: ToolCall[] | null }> {
  const url = `${apiBase}/chat/completions`;
  const body: any = { model, messages, temperature: 0.3, max_tokens: 2000 };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await post(url, headers, body, TIMEOUT_MS);

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: ToolCall[];
      };
    }>;
  };

  const message = json.choices?.[0]?.message;
  if (!message) throw new Error("API returned no choices");

  return {
    content: message.content ?? null,
    tool_calls: message.tool_calls ?? null,
  };
}

async function tryGateway(messages: LlmMessage[], tools: ToolDefinition[], token: string): Promise<{ content: string | null; tool_calls: ToolCall[] | null } | null> {
  try {
    return await callProvider(
      AI_GATEWAY_BASE,
      { Authorization: `Bearer ${token}` },
      GATEWAY_MODEL,
      messages,
      tools,
    );
  } catch {
    return null;
  }
}

async function tryDirectGemini(messages: LlmMessage[], tools: ToolDefinition[], apiKey: string): Promise<{ content: string | null; tool_calls: ToolCall[] | null } | null> {
  try {
    return await callProvider(
      DIRECT_GEMINI_BASE,
      { Authorization: `Bearer ${apiKey}` },
      DIRECT_GEMINI_MODEL,
      messages,
      tools,
    );
  } catch {
    return null;
  }
}

async function tryOpenRouter(messages: LlmMessage[], tools: ToolDefinition[], apiKey: string): Promise<{ content: string | null; tool_calls: ToolCall[] | null } | null> {
  try {
    return await callProvider(
      OPENROUTER_API_BASE,
      { Authorization: `Bearer ${apiKey}` },
      OPENROUTER_MODEL,
      messages,
      tools,
    );
  } catch {
    return null;
  }
}

export interface FunctionCallResult {
  text: string;
  tool_invocations: ToolInvocation[];
  provider: string;
  route: string;
  model: string;
}

const tools = [STATUS_CORRELATOR_TOOL];

export async function callLLMWithTools(
  systemPrompt: string,
  userPrompt: string,
  env: {
    GEMINI_API_KEY: string;
    OPENROUTER_API_KEY?: string;
    CLOUDFLARE_API_TOKEN?: string;
  },
): Promise<FunctionCallResult | { ok: false; error: string }> {
  if (!env.GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY is required" };
  }

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let provider = "gemini", route = "gateway", model = GATEWAY_MODEL;

  let firstResponse = null;
  if (env.CLOUDFLARE_API_TOKEN) {
    firstResponse = await tryGateway(messages, tools, env.CLOUDFLARE_API_TOKEN);
    route = "gateway";
  }
  if (!firstResponse) {
    firstResponse = await tryDirectGemini(messages, tools, env.GEMINI_API_KEY);
    provider = "gemini";
    route = "direct";
  }
  if (!firstResponse && env.OPENROUTER_API_KEY) {
    firstResponse = await tryOpenRouter(messages, tools, env.OPENROUTER_API_KEY);
    provider = "openrouter";
    route = "direct";
  }

  if (!firstResponse) {
    return { ok: false, error: "All LLM providers failed" };
  }

  const toolInvocations: ToolInvocation[] = [];

  if (firstResponse.tool_calls && firstResponse.tool_calls.length > 0) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: firstResponse.tool_calls,
    });

    for (const tc of firstResponse.tool_calls) {
      if (tc.function.name === "status_correlator") {
        let args: { service: string };
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { service: "unknown" };
        }
        const result = await checkStatus(args.service);
        toolInvocations.push({
          tool: "status_correlator",
          input: { service: args.service },
          output: result,
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
    }

    if (firstResponse.content !== null && firstResponse.content !== undefined) {
    }

    let secondResponse = null;
    if (env.CLOUDFLARE_API_TOKEN) {
      secondResponse = await tryGateway(messages, [], env.CLOUDFLARE_API_TOKEN);
    }
    if (!secondResponse) {
      secondResponse = await tryDirectGemini(messages, [], env.GEMINI_API_KEY);
    }
    if (!secondResponse && env.OPENROUTER_API_KEY) {
      secondResponse = await tryOpenRouter(messages, [], env.OPENROUTER_API_KEY);
    }

    if (!secondResponse) {
      return { ok: false, error: "LLM failed on follow-up call after tool invocation" };
    }

    return {
      text: secondResponse.content ?? "",
      tool_invocations: toolInvocations,
      provider,
      route,
      model,
    };
  }

  return {
    text: firstResponse.content ?? "",
    tool_invocations: toolInvocations,
    provider,
    route,
    model,
  };
}
