import { Agent, routeAgentRequest } from "agents";

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

export class PreventionAgent extends Agent<Env> {
  async ping(): Promise<string> {
    return "pong";
  }

  async generatePrevention(_input: PreventionInput): Promise<PreventionOutput> {
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
