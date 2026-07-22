const AI_GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1/05c934a23d9100d41fc6e9c89ab6cbcb/incidentiq/compat";
const GATEWAY_MODEL = "google-ai-studio/gemini-2.5-flash";
const DIRECT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const DIRECT_GEMINI_MODEL = "gemini-2.5-flash";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODELS = [
  "google/gemma-4-26b-a4b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "openrouter/free",
];
const DEFAULT_TEMPERATURE = 0.3;
const TIMEOUT_MS = 10000;

export interface CallLLMOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
  env: {
    GEMINI_API_KEY: string;
    OPENROUTER_API_KEY?: string;
    CLOUDFLARE_API_TOKEN?: string;
    AI?: any;
  };
}

export interface CallLLMResult {
  text: string;
  provider: "gemini" | "openrouter" | "workers-ai";
  route: "gateway" | "direct";
  model: string;
}

export interface CallLLMError {
  ok: false;
  error: string;
  provider: "gemini" | "openrouter" | "workers-ai" | null;
  route: "gateway" | "direct" | null;
}

export type CallLLMResponse = CallLLMResult | CallLLMError;

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Response> {
  return Promise.race([
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}

async function callProvider(
  apiBase: string,
  headers: Record<string, string>,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
): Promise<{ text: string; raw: unknown }> {
  const url = `${apiBase}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature,
  };

  const response = await post(url, headers, body, TIMEOUT_MS);

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("API returned no text content");
  }

  return { text, raw: json };
}

function logLLMEvent(event: string, provider: string, route: string, detail: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    agent_name: "callLLM",
    event,
    provider,
    route,
    detail,
    timestamp: new Date().toISOString(),
    ...extra,
  }));
}

async function tryWorkersAI(
  systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number,
  env: { AI?: any },
): Promise<CallLLMResult | null> {
  if (!env.AI) return null;
  const t0 = performance.now();
  try {
    const result = await Promise.race([
      env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }) as Promise<{ response?: string; choices?: Array<{ message?: { content?: string } }> }>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
    ]);
    const text = result.response || result.choices?.[0]?.message?.content || "";
    logLLMEvent("completed", "workers-ai", "direct", "Workers AI call succeeded", { latency_ms: Math.round(performance.now() - t0) });
    return { text, provider: "workers-ai", route: "direct", model: "@cf/meta/llama-3.1-8b-instruct-fp8" };
  } catch (err) {
    logLLMEvent("completed", "workers-ai", "direct", "Workers AI call failed: " + (err instanceof Error ? err.message : String(err)), { latency_ms: Math.round(performance.now() - t0) });
    return null;
  }
}

async function tryGateway(
  systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number,
  env: { CLOUDFLARE_API_TOKEN?: string },
): Promise<CallLLMResult | null> {
  if (!env.CLOUDFLARE_API_TOKEN) return null;
  const t0 = performance.now();
  try {
    const result = await callProvider(
      AI_GATEWAY_BASE,
      { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      GATEWAY_MODEL,
      systemPrompt, userPrompt, maxTokens, temperature,
    );
    logLLMEvent("completed", "gemini", "gateway", "Gateway call succeeded", { latency_ms: Math.round(performance.now() - t0) });
    return { text: result.text, provider: "gemini", route: "gateway", model: GATEWAY_MODEL };
  } catch (err) {
    logLLMEvent("completed", "gemini", "gateway", "Gateway call failed: " + (err instanceof Error ? err.message : String(err)), { latency_ms: Math.round(performance.now() - t0) });
    return null;
  }
}

async function tryDirectGemini(
  systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number,
  env: { GEMINI_API_KEY: string },
): Promise<CallLLMResult | null> {
  const t0 = performance.now();
  try {
    const result = await callProvider(
      DIRECT_GEMINI_BASE,
      { "Authorization": `Bearer ${env.GEMINI_API_KEY}` },
      DIRECT_GEMINI_MODEL,
      systemPrompt, userPrompt, maxTokens, temperature,
    );
    logLLMEvent("completed", "gemini", "direct", "Direct Gemini call succeeded", { latency_ms: Math.round(performance.now() - t0) });
    return { text: result.text, provider: "gemini", route: "direct", model: DIRECT_GEMINI_MODEL };
  } catch (err) {
    logLLMEvent("completed", "gemini", "direct", "Direct Gemini call failed: " + (err instanceof Error ? err.message : String(err)), { latency_ms: Math.round(performance.now() - t0) });
    return null;
  }
}

async function tryOpenRouter(
  systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number,
  env: { OPENROUTER_API_KEY?: string },
): Promise<CallLLMResult | null> {
  const t0 = performance.now();
  for (const model of OPENROUTER_MODELS) {
    try {
      const result = await callProvider(
        OPENROUTER_API_BASE,
        { "Authorization": `Bearer ${env.OPENROUTER_API_KEY}` },
        model,
        systemPrompt, userPrompt, maxTokens, temperature,
      );
      logLLMEvent("completed", "openrouter", "direct", `OpenRouter ${model} succeeded`, { latency_ms: Math.round(performance.now() - t0) });
      return { text: result.text, provider: "openrouter", route: "direct", model };
    } catch (err) {
      logLLMEvent("completed", "openrouter", "direct", `OpenRouter ${model} failed: ${err instanceof Error ? err.message : String(err)}`, { latency_ms: Math.round(performance.now() - t0) });
    }
  }
  return null;
}

function isErrorContent(text: string | null | undefined): boolean {
  if (!text) return true;
  const start = text.substring(0, 100).toLowerCase();
  return start.includes("error") || start.includes("unavailable") || start.includes("quota") ||
    start.includes("rate limit") || start.includes("too many") || start.includes("429") ||
    start.includes("insufficient") || start.includes("upstream") || start.includes("overloaded");
}

async function _callLLM(opts: CallLLMOptions): Promise<CallLLMResponse> {
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;

  if (!opts.env.GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY is required", provider: null, route: null };
  }

  let result: CallLLMResult | null = null;

  if (opts.env.OPENROUTER_API_KEY) {
    result = await tryOpenRouter(opts.systemPrompt, opts.userPrompt, opts.maxTokens, temperature, opts.env);
    if (isErrorContent(result?.text)) result = null;
  }
  if (!result && opts.env.CLOUDFLARE_API_TOKEN) {
    result = await tryGateway(opts.systemPrompt, opts.userPrompt, opts.maxTokens, temperature, opts.env);
    if (isErrorContent(result?.text)) result = null;
  }
  if (!result) {
    result = await tryDirectGemini(opts.systemPrompt, opts.userPrompt, opts.maxTokens, temperature, opts.env);
    if (isErrorContent(result?.text)) result = null;
  }
  if (!result && opts.env.AI) {
    result = await tryWorkersAI(opts.systemPrompt, opts.userPrompt, opts.maxTokens, temperature, opts.env);
    if (isErrorContent(result?.text)) result = null;
  }

  if (result) return result;

  return {
    ok: false,
    error: "All LLM providers failed",
    provider: null,
    route: null,
  };
}

const LLM_CALL_TIMEOUT_MS = 60000;

export async function callLLM(opts: CallLLMOptions): Promise<CallLLMResponse> {
  return Promise.race([
    _callLLM(opts),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), LLM_CALL_TIMEOUT_MS)),
  ]).catch(() => ({
    ok: false,
    error: "All LLM providers failed",
    provider: null,
    route: null,
  }));
}
