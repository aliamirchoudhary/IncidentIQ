import { Agent, routeAgentRequest } from "agents";
import { callLLM } from "shared";

interface Env {
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

interface TimelineEntry {
  time: string;
  event: string;
  confidence: number;
  note?: string;
}

interface RootCauseData {
  cause: string;
  confidence: number;
  evidence: string;
  needs_review: boolean;
}

interface Recommendation {
  recommendation: string;
  reference: string | null;
}

export interface ModeratorInput {
  incident_id: string;
  request_id: string;
  timeline: TimelineEntry[];
  root_cause: RootCauseData;
  recommendations: Recommendation[];
}

interface DraftReport {
  summary: string;
  timeline: TimelineEntry[];
  root_cause: RootCauseData;
  recommendations: Recommendation[];
  needs_review: boolean;
}

export interface ModeratorOutput {
  status: "success" | "failure";
  report?: DraftReport;
  error?: string;
  provider_used?: string;
  route_used?: string;
}

function logJson(incidentId: string, requestId: string, agentName: string, version: number, event: string, status: string, detail: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    incident_id: incidentId,
    request_id: requestId,
    agent_name: agentName,
    version,
    event,
    status,
    detail,
    timestamp: new Date().toISOString(),
    ...extra,
  }));
}

const MODERATOR_TEMPERATURE = 0.4;
const MODERATOR_MAX_TOKENS = 1000;

const MODERATOR_SYSTEM_PROMPT = `You are a report-writing assistant for incident post-mortems. Your job is to write a concise, human-readable narrative summary paragraph that synthesizes the incident timeline, root cause, and recommendations.

Rules:
- Write exactly ONE paragraph (3-6 sentences) summarizing what happened, why, and what to do about it.
- Do NOT alter, re-interpret, or add to the structured data provided. Only narrate it.
- Do NOT introduce new facts, causes, or recommendations not present in the input.
- If the root cause confidence is below 0.5, note the uncertainty in the summary.
- Return ONLY valid JSON, no markdown formatting, no explanation.

Output format:
{"summary":"A single paragraph narrative summary of the incident."}`;

function extractJson(text: string): string {
  const codeMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return codeMatch ? codeMatch[1].trim() : text.trim();
}

function templateSummary(input: ModeratorInput): string {
  const rc = input.root_cause;
  const recCount = input.recommendations.length;
  let summary = `This incident report documents an analysis of an incident with ${input.timeline.length} recorded events. `;
  summary += `The root cause was identified as: "${rc.cause}" (confidence: ${Math.round(rc.confidence * 100)}%). `;
  if (rc.needs_review) {
    summary += `Root cause confidence is below threshold, so human review is required before finalization. `;
  }
  if (recCount > 0) {
    summary += `${recCount} preventive recommendation${recCount > 1 ? "s were" : " was"} generated to address the underlying causes. `;
  } else {
    summary += `No specific preventive recommendations were generated. `;
  }
  summary += `A human review is needed to approve the findings before this report is finalized.`;
  return summary;
}

function buildUserPrompt(input: ModeratorInput): string {
  const timelineStr = input.timeline
    .map((e) => `[${e.time}] ${e.event} (confidence: ${e.confidence})${e.note ? ` -- ${e.note}` : ""}`)
    .join("\n");

  const rootCauseStr = `Cause: ${input.root_cause.cause}\nConfidence: ${input.root_cause.confidence}\nEvidence: ${input.root_cause.evidence}\nNeeds Review: ${input.root_cause.needs_review}`;

  const recsStr = input.recommendations
    .map((r, i) => `${i + 1}. ${r.recommendation}${r.reference ? ` [ref: ${r.reference}]` : ""}`)
    .join("\n");

  return `=== TIMELINE ===\n${timelineStr}\n\n=== ROOT CAUSE ===\n${rootCauseStr}\n\n=== RECOMMENDATIONS ===\n${recsStr || "(None)"}`;
}

export class ModeratorAgent extends Agent<Env> {
  async ping(): Promise<string> {
    return "pong";
  }

  async generateReport(input: ModeratorInput): Promise<ModeratorOutput> {
    const startTime = performance.now();
    logJson(input.incident_id, input.request_id, "ModeratorAgent", 0, "started", "pending", "Report generation started");

    if (!input.timeline || input.timeline.length === 0) {
      logJson(input.incident_id, input.request_id, "ModeratorAgent", 0, "completed", "failure", "Timeline is empty", { latency_ms: 0 });
      return { status: "failure", error: "Timeline is empty" };
    }

    try {
      const { summary, provider, route } = await this.tryLLMSummary(input);

      const report: DraftReport = {
        summary,
        timeline: input.timeline,
        root_cause: input.root_cause,
        recommendations: input.recommendations,
        needs_review: input.root_cause.needs_review,
      };

      const latency = performance.now() - startTime;
      logJson(input.incident_id, input.request_id, "ModeratorAgent", 0, "completed", "success",
        `Draft report assembled`,
        { latency_ms: Math.round(latency), provider, route });
      return { status: "success", report, provider_used: provider, route_used: route };
    } catch (err) {
      const latency = performance.now() - startTime;
      logJson(input.incident_id, input.request_id, "ModeratorAgent", 0, "completed", "failure",
        err instanceof Error ? err.message : String(err),
        { latency_ms: Math.round(latency) });
      return {
        status: "failure",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async tryLLMSummary(input: ModeratorInput): Promise<{ summary: string; provider?: string; route?: string }> {
    const response = await callLLM({
      systemPrompt: MODERATOR_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(input),
      maxTokens: MODERATOR_MAX_TOKENS,
      temperature: MODERATOR_TEMPERATURE,
      env: {
        GEMINI_API_KEY: this.env.GEMINI_API_KEY ?? "",
        OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
        CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
      },
    });

    if (!("text" in response)) {
      return { summary: templateSummary(input) };
    }

    try {
      const cleaned = extractJson(response.text);
      const parsed = JSON.parse(cleaned);
      if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0) {
        return { summary: parsed.summary, provider: response.provider, route: response.route };
      }
    } catch {
    }

    return { summary: templateSummary(input) };
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
