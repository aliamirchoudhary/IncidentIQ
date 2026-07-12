import { Agent, routeAgentRequest } from "agents";
import { callLLMWithTools } from "./call-llm-with-tools";

interface Env {
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

interface RetrievedChunk {
  chunk_id: string;
  title: string;
  content: string;
  score: number;
}

interface TimelineEntry {
  time: string;
  event: string;
  confidence: number;
  note?: string;
}

export interface RootCauseInput {
  incident_id: string;
  timeline: TimelineEntry[];
  retrieved_context: RetrievedChunk[];
  confidence_threshold_override?: number;
}

interface ToolInvocation {
  tool: string;
  input: object;
  output: object;
}

export interface RootCauseOutput {
  status: "success" | "failure";
  cause?: string;
  confidence?: number;
  evidence?: string;
  tool_invocations?: ToolInvocation[];
  needs_review?: boolean;
  error?: string;
  provider_used?: string;
  route_used?: string;
}

const CONFIDENCE_THRESHOLD = 0.5;
const ROOTCAUSE_TEMPERATURE = 0.3;
const ROOTCAUSE_MAX_TOKENS = 2000;

const ROOTCAUSE_SYSTEM_PROMPT = `You are a root cause analysis assistant for incident post-mortems. Given a timeline of events and relevant reference material, produce a cited root cause hypothesis.

Rules:
- Ground your analysis in the provided "Reference Material" below. If you reference a source, cite it by title and chunk_id in your evidence.
- If you cannot find evidence in the provided reference material for a claim, say so explicitly — never fabricate a citation to a chunk that was not provided.
- Confidence (0.0-1.0): your overall certainty that this cause is correct given the available evidence. Consider: how complete is the timeline? How directly does the reference material match?
- If the timeline suggests a third-party dependency issue (e.g., cloud provider outage, SaaS service down, external API failure), you may use the status_correlator tool to check the current status of that service.
- Return ONLY valid JSON, no markdown formatting, no explanation.

Output format:
{"cause":"one-sentence root cause","confidence":0.0-1.0,"evidence":"explanation with citations to reference material by title/chunk_id","tool_invocations":[],"needs_review":false}`;

function extractJson(text: string): string {
  const codeMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return codeMatch ? codeMatch[1].trim() : text.trim();
}

function buildUserPrompt(input: RootCauseInput): string {
  const timelineStr = input.timeline
    .map((e) => `[${e.time}] ${e.event} (confidence: ${e.confidence})${e.note ? ` -- ${e.note}` : ""}`)
    .join("\n");

  const contextStr = input.retrieved_context
    .map((c) => `---\nTitle: ${c.title}\nChunk ID: ${c.chunk_id}\nRelevance: ${c.score.toFixed(4)}\n${c.content}`)
    .join("\n");

  return `=== TIMELINE ===\n${timelineStr}\n\n=== REFERENCE MATERIAL ===\n${contextStr || "(No reference material retrieved)"}`;
}

function deterministicRootCause(input: RootCauseInput): { cause: string; confidence: number; evidence: string; needs_review: boolean } {
  return {
    cause: "Insufficient data to determine root cause",
    confidence: 0.1,
    evidence: `Timeline has ${input.timeline.length} events and ${input.retrieved_context.length} reference chunks. LLM was unavailable; deterministic analysis cannot determine root cause. Manual review required.`,
    needs_review: true,
  };
}

export class RootCauseAgent extends Agent<Env> {
  async ping(): Promise<string> {
    return "pong";
  }

  async analyzeRootCause(input: RootCauseInput): Promise<RootCauseOutput> {
    if (!input.timeline || input.timeline.length === 0) {
      return { status: "failure", error: "Timeline is empty" };
    }

    const threshold = input.confidence_threshold_override ?? CONFIDENCE_THRESHOLD;

    try {
      const llmResult = await this.tryLLMRootCause(input);
      if (llmResult) return llmResult;

      const fallback = deterministicRootCause(input);
      return {
        status: "success",
        cause: fallback.cause,
        confidence: fallback.confidence,
        evidence: fallback.evidence,
        tool_invocations: [],
        needs_review: fallback.confidence < threshold,
      };
    } catch (err) {
      return {
        status: "failure",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async tryLLMRootCause(input: RootCauseInput): Promise<RootCauseOutput | null> {
    if (!this.env.GEMINI_API_KEY) return null;

    const response = await callLLMWithTools(
      ROOTCAUSE_SYSTEM_PROMPT,
      buildUserPrompt(input),
      {
        GEMINI_API_KEY: this.env.GEMINI_API_KEY,
        OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
        CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
      },
    );

    if ("ok" in response) return null;

    try {
      const cleaned = extractJson(response.text);
      const parsed = JSON.parse(cleaned);

      if (typeof parsed.cause !== "string" || typeof parsed.confidence !== "number") {
        return null;
      }

      const threshold = input.confidence_threshold_override ?? CONFIDENCE_THRESHOLD;
      const confidence = Math.max(0, Math.min(1, parsed.confidence));

      return {
        status: "success",
        cause: parsed.cause,
        confidence,
        evidence: typeof parsed.evidence === "string" ? parsed.evidence : "",
        tool_invocations: response.tool_invocations,
        needs_review: confidence < threshold,
        provider_used: response.provider,
        route_used: response.route,
      };
    } catch {
      return null;
    }
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
