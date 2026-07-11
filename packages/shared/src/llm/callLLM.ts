const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_MODEL = "gemini-2.5-flash";
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
  };
}

export interface CallLLMResult {
  text: string;
  provider: "gemini" | "openrouter";
  model: string;
}

export interface CallLLMError {
  ok: false;
  error: string;
  provider: "gemini" | "openrouter" | null;
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

function chatBody(systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number) {
  return {
    model: GEMINI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature,
  };
}

async function callProvider(
  apiBase: string,
  apiKey: string,
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

  const response = await post(url, { "Authorization": `Bearer ${apiKey}` }, body, TIMEOUT_MS);

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

export async function callLLM(opts: CallLLMOptions): Promise<CallLLMResponse> {
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;

  if (!opts.env.GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY is required", provider: null };
  }

  try {
    const result = await callProvider(
      GEMINI_API_BASE, opts.env.GEMINI_API_KEY, GEMINI_MODEL,
      opts.systemPrompt, opts.userPrompt, opts.maxTokens, temperature,
    );
    return { text: result.text, provider: "gemini", model: GEMINI_MODEL };
  } catch (primaryError) {
    if (!opts.env.OPENROUTER_API_KEY) {
      return {
        ok: false,
        error: `Gemini failed and no OpenRouter fallback configured: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`,
        provider: "gemini",
      };
    }

    try {
      const result = await callProvider(
        OPENROUTER_API_BASE, opts.env.OPENROUTER_API_KEY, OPENROUTER_MODEL,
        opts.systemPrompt, opts.userPrompt, opts.maxTokens, temperature,
      );
      return { text: result.text, provider: "openrouter", model: OPENROUTER_MODEL };
    } catch (fallbackError) {
      return {
        ok: false,
        error: `Gemini: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}. OpenRouter: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        provider: null,
      };
    }
  }
}
