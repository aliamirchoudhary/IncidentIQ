const AI_GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1/05c934a23d9100d41fc6e9c89ab6cbcb/incidentiq/compat";
const GATEWAY_MODEL = "google-ai-studio/gemini-2.5-flash";
const DIRECT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const DIRECT_GEMINI_MODEL = "gemini-2.5-flash";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_TEMPERATURE = 0.3;
const TIMEOUT_MS = 30000;

export interface CallLLMOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
  env: {
    GEMINI_API_KEY: string;
    OPENROUTER_API_KEY?: string;
    CLOUDFLARE_API_TOKEN?: string;
  };
}

export interface CallLLMResult {
  text: string;
  provider: "gateway" | "gemini" | "openrouter";
  model: string;
}

export interface CallLLMError {
  ok: false;
  error: string;
  provider: "gateway" | "gemini" | "openrouter" | null;
}

export type CallLLMResponse = CallLLMResult | CallLLMError;

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

async function tryGateway(
  systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number,
  env: { CLOUDFLARE_API_TOKEN?: string },
): Promise<CallLLMResult | null> {
  if (!env.CLOUDFLARE_API_TOKEN) return null;
  try {
    const result = await callProvider(
      AI_GATEWAY_BASE,
      { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      GATEWAY_MODEL,
      systemPrompt, userPrompt, maxTokens, temperature,
    );
    return { text: result.text, provider: "gateway", model: GATEWAY_MODEL };
  } catch {
    return null;
  }
}

async function tryDirectGemini(
  systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number,
  env: { GEMINI_API_KEY: string },
): Promise<CallLLMResult | null> {
  try {
    const result = await callProvider(
      DIRECT_GEMINI_BASE,
      { "Authorization": `Bearer ${env.GEMINI_API_KEY}` },
      DIRECT_GEMINI_MODEL,
      systemPrompt, userPrompt, maxTokens, temperature,
    );
    return { text: result.text, provider: "gemini", model: DIRECT_GEMINI_MODEL };
  } catch {
    return null;
  }
}

async function tryOpenRouter(
  systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number,
  env: { OPENROUTER_API_KEY: string },
): Promise<CallLLMResult | null> {
  try {
    const result = await callProvider(
      OPENROUTER_API_BASE,
      { "Authorization": `Bearer ${env.OPENROUTER_API_KEY}` },
      OPENROUTER_MODEL,
      systemPrompt, userPrompt, maxTokens, temperature,
    );
    return { text: result.text, provider: "openrouter", model: OPENROUTER_MODEL };
  } catch {
    return null;
  }
}

export async function callLLM(opts: CallLLMOptions): Promise<CallLLMResponse> {
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;

  if (!opts.env.GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY is required", provider: null };
  }

  const result =
    (await tryGateway(opts.systemPrompt, opts.userPrompt, opts.maxTokens, temperature, opts.env)) ??
    (await tryDirectGemini(opts.systemPrompt, opts.userPrompt, opts.maxTokens, temperature, opts.env)) ??
    (opts.env.OPENROUTER_API_KEY ? await tryOpenRouter(opts.systemPrompt, opts.userPrompt, opts.maxTokens, temperature, opts.env) : null);

  if (result) return result;

  return {
    ok: false,
    error: "All LLM providers failed",
    provider: null,
  };
}
