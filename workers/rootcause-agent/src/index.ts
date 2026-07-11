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

export interface RootCauseInput {
  incident_id: string;
  timeline: Array<{ time: string; event: string; confidence: number; note?: string }>;
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

export class RootCauseAgent extends Agent<Env> {
  async ping(): Promise<string> {
    return "pong";
  }

  async analyzeRootCause(_input: RootCauseInput): Promise<RootCauseOutput> {
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
