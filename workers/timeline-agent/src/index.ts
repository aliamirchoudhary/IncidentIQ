import { Agent, routeAgentRequest } from "agents";
import { callLLM, type CallLLMResponse } from "shared";

interface Env {
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

interface TimelineEventInput {
  timestamp: string | null;
  detail: string;
  source?: string;
}

export interface TimelineInput {
  incident_id: string;
  raw_events: TimelineEventInput[];
}

interface TimelineEntry {
  time: string;
  event: string;
  confidence: number;
  note?: string;
}

export interface TimelineOutput {
  status: "success" | "failure";
  timeline?: TimelineEntry[];
  error?: string;
  provider_used?: string;
  route_used?: string;
}

export class TimelineAgent extends Agent<Env> {
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

  async generateTimeline(_input: TimelineInput): Promise<TimelineOutput> {
    return { status: "failure", error: "not implemented" };
  }

  /** Placeholder no-op tool for scaffolding — real tool-calling starts in Stage 10 */
  async statusCorrelator(_service: string): Promise<{ status: string }> {
    return { status: "unknown" };
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
};
