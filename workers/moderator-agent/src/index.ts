import { Agent, routeAgentRequest } from "agents";

interface Env {
  GEMINI_API_KEY?: string;
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
}

interface Recommendation {
  recommendation: string;
  reference: string | null;
}

export interface ModeratorInput {
  incident_id: string;
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
}

export class ModeratorAgent extends Agent<Env> {
  async ping(): Promise<string> {
    return "pong";
  }

  async generateReport(_input: ModeratorInput): Promise<ModeratorOutput> {
    return { status: "failure", error: "not implemented" };
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
