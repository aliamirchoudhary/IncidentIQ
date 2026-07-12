import { Agent, routeAgentRequest } from "agents";
import { callLLM, type CallLLMResponse } from "shared";

interface Env {
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

interface RetrievedChunk {
  chunk_id: string;
  title: string;
  content: string;
  score: number;
}

export interface PreventionInput {
  incident_id: string;
  root_cause: string;
  root_cause_evidence: string;
  retrieved_context: RetrievedChunk[];
}

interface Recommendation {
  recommendation: string;
  reference: string | null;
}

export interface PreventionOutput {
  status: "success" | "failure";
  recommendations?: Recommendation[];
  error?: string;
  provider_used?: string;
  route_used?: string;
}

const PREVENTION_SYSTEM_PROMPT = `You are a prevention recommendations assistant for incident post-mortems. Given a root cause and reference material, produce concrete, actionable preventive recommendations.

Rules:
- Each recommendation must be specific to the given root cause — not generic boilerplate that could apply to any incident.
- Reference material is provided to ground your recommendations. If you draw from a specific source, include its title as the reference. If no source supports a recommendation, set reference to null.
- Never fabricate a citation — set reference to null when nothing groundable.
- Prefer 2-4 specific, actionable recommendations over a long list of vague ones.
- Return ONLY valid JSON, no markdown formatting, no explanation.

Output format:
{"recommendations":[{"recommendation":"concrete action","reference":"source title or null"},{"recommendation":"another action","reference":null}]}`;

const PREVENTION_TEMPERATURE = 0.3;
const PREVENTION_MAX_TOKENS = 1500;

function extractJson(text: string): string {
  const codeMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return codeMatch ? codeMatch[1].trim() : text.trim();
}

function buildUserPrompt(input: PreventionInput): string {
  const contextStr = input.retrieved_context
    .map((c) => `---\nTitle: ${c.title}\nChunk ID: ${c.chunk_id}\nRelevance: ${c.score.toFixed(4)}\n${c.content}`)
    .join("\n");

  return `=== ROOT CAUSE ===\n${input.root_cause}\n\n=== EVIDENCE ===\n${input.root_cause_evidence}\n\n=== REFERENCE MATERIAL ===\n${contextStr || "(No reference material retrieved)"}`;
}

function deterministicPrevention(): Recommendation[] {
  return [
    {
      recommendation: "Review and document the root cause: " + "insufficient data to generate specific recommendations",
      reference: null,
    },
  ];
}

export class PreventionAgent extends Agent<Env> {
  async ping(): Promise<string> {
    return "pong";
  }

  async generatePrevention(input: PreventionInput): Promise<PreventionOutput> {
    if (!input.root_cause) {
      return { status: "failure", error: "Root cause is empty" };
    }

    try {
      const llmResult = await this.tryLLMPrevention(input);
      if (llmResult) return llmResult;

      const fallback = deterministicPrevention();
      return {
        status: "success",
        recommendations: fallback,
      };
    } catch (err) {
      return {
        status: "failure",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async tryLLMPrevention(input: PreventionInput): Promise<PreventionOutput | null> {
    const response = await callLLM({
      systemPrompt: PREVENTION_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(input),
      maxTokens: PREVENTION_MAX_TOKENS,
      temperature: PREVENTION_TEMPERATURE,
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
      if (!parsed.recommendations || !Array.isArray(parsed.recommendations)) {
        return null;
      }
      const validated: Recommendation[] = [];
      for (const rec of parsed.recommendations) {
        if (typeof rec.recommendation === "string") {
          validated.push({
            recommendation: rec.recommendation,
            reference: typeof rec.reference === "string" ? rec.reference : null,
          });
        }
      }
      if (validated.length === 0) {
        return null;
      }
      return {
        status: "success",
        recommendations: validated,
        provider_used: provider,
        route_used: route,
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
