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

const TIMELINE_SYSTEM_PROMPT = `You are a timeline analysis assistant for incident post-mortems. Given raw incident events (possibly out of order, some with missing timestamps), produce a chronologically ordered timeline with confidence annotations.

Rules:
- Sort all events chronologically by timestamp
- For events with explicit timestamps, order them by time; invalid or malformed timestamps should be treated as missing
- For events without timestamps, infer their position from event context and detail, and mark confidence accordingly
- Identify any gaps, anomalies, or contradictory events using the note field
- Confidence: 1.0 for events with explicit valid timestamps, 0.5-0.9 for inferred positions, 0.0-0.4 for very uncertain placements
- Return ONLY valid JSON, no markdown formatting, no explanation

Input format:
{"raw_events":[{"timestamp":"ISO string or null","detail":"description","source":"optional"},...]}

Output format:
{"timeline":[{"time":"ISO string or empty string if unknown","event":"description","confidence":0.95,"note":"annotation or null"},...]}`;

const TIMELINE_TEMPERATURE = 0.2;
const TIMELINE_MAX_TOKENS = 2000;

function extractJson(text: string): string {
  const codeMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return codeMatch ? codeMatch[1].trim() : text.trim();
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

  async generateTimeline(input: TimelineInput): Promise<TimelineOutput> {
    try {
      const llmResult = await this.tryLLMTimeline(input.raw_events);
      if (llmResult) {
        return llmResult;
      }
      const fallback = this.deterministicTimeline(input.raw_events);
      return {
        status: "success",
        timeline: fallback,
      };
    } catch (err) {
      return {
        status: "failure",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private deterministicTimeline(events: TimelineEventInput[]): TimelineEntry[] {
    const withTime = events
      .filter((e) => e.timestamp && !isNaN(new Date(e.timestamp).getTime()))
      .sort((a, b) => new Date(a.timestamp!).getTime() - new Date(b.timestamp!).getTime())
      .map((e) => ({ time: e.timestamp!, event: e.detail, confidence: 1.0 }));
    const withoutTime = events
      .filter((e) => !e.timestamp || isNaN(new Date(e.timestamp).getTime()))
      .map((e) => ({ time: "", event: e.detail, confidence: 0.5, note: "timestamp missing, position estimated" }));
    return [...withTime, ...withoutTime];
  }

  private async tryLLMTimeline(rawEvents: TimelineEventInput[]): Promise<TimelineOutput | null> {
    const response = await callLLM({
      systemPrompt: TIMELINE_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({ raw_events: rawEvents }),
      maxTokens: TIMELINE_MAX_TOKENS,
      temperature: TIMELINE_TEMPERATURE,
      env: {
        GEMINI_API_KEY: this.env.GEMINI_API_KEY,
        OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
        CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
      },
    });

    if (!("text" in response)) {
      return null;
    }

    const { text, provider, route } = response;

    try {
      const cleaned = extractJson(text);
      const parsed = JSON.parse(cleaned);
      if (!parsed.timeline || !Array.isArray(parsed.timeline)) {
        return null;
      }
      const validated: TimelineEntry[] = [];
      for (const entry of parsed.timeline) {
        if (typeof entry.time === "string" && typeof entry.event === "string" && typeof entry.confidence === "number") {
          validated.push({
            time: entry.time,
            event: entry.event,
            confidence: Math.max(0, Math.min(1, entry.confidence)),
            note: typeof entry.note === "string" ? entry.note : undefined,
          });
        }
      }
      if (validated.length === 0) {
        return null;
      }
      return {
        status: "success",
        timeline: validated,
        provider_used: provider,
        route_used: route,
      };
    } catch {
      return null;
    }
  }

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
