import { WorkerEntrypoint } from "cloudflare:workers";
import { callLLM, type CallLLMResponse } from "shared";

interface Env {
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

export default class extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }

  async ping(): Promise<string> {
    return "pong";
  }

  async debugCallLLM(input: string): Promise<CallLLMResponse> {
    return callLLM({
      systemPrompt: "You are a helpful assistant. Reply concisely.",
      userPrompt: input,
      maxTokens: 100,
      temperature: 0.3,
      env: {
        GEMINI_API_KEY: this.env.GEMINI_API_KEY,
        OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
        CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
      },
    });
  }
}
