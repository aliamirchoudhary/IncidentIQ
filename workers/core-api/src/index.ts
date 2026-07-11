import { WorkerEntrypoint } from "cloudflare:workers";
import { IncidentRoom, type IncidentState } from "./incident-room";
import { createIncident, addEvent, getIncident, getReport } from "./ingestion";

export { IncidentRoom };

interface Env {
  TIMELINE_AGENT: { ping(): Promise<string>; debugCallLLM(input: string): Promise<unknown> };
  ROOTCAUSE_AGENT: { ping(): Promise<string> };
  PREVENTION_AGENT: { ping(): Promise<string> };
  MODERATOR_AGENT: { ping(): Promise<string> };
  INCIDENT_ROOM: DurableObjectNamespace<IncidentRoom>;
  incidentiq_db: D1Database;
}

interface IncidentDataLoose {
  state: string;
  version: number;
  incident: unknown;
  events: unknown[];
}

interface TransitionResultLoose {
  success: boolean;
  state?: IncidentState;
  version?: number;
  error?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function addCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function getOrigin(request: Request): string {
  const origin = request.headers.get("Origin");
  if (origin) return origin;
  const referer = request.headers.get("Referer");
  if (referer) {
    try { return new URL(referer).origin; } catch { return "*"; }
  }
  return "*";
}

function getAuthUser(request: Request): { id: string } | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return { id: "unknown" };
}

function getRoom(env: Env, id: string): DurableObjectStub<IncidentRoom> {
  const doId = env.INCIDENT_ROOM.idFromName(id);
  return env.INCIDENT_ROOM.get(doId);
}

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const origin = getOrigin(request);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const path = url.pathname;

    if (method === "GET" && path === "/api/v1/debug/ping-all") {
      return addCors(await this.handlePingAll(), origin);
    }

    if (method === "POST" && path === "/api/v1/debug/do/create") {
      return addCors(await this.handleDoCreate(), origin);
    }

    if (method === "GET" && path === "/api/v1/debug/call-llm") {
      return addCors(await this.handleDebugCallLLM(url), origin);
    }

    const doMatch = path.match(/^\/api\/v1\/debug\/do\/([^/]+)$/);
    if (doMatch) {
      const id = doMatch[1];
      if (method === "GET") return addCors(await this.handleDoGet(id), origin);
      if (method === "POST") {
        const body = await request.json().catch(() => ({})) as { transition?: string };
        return addCors(await this.handleDoTransition(id, body.transition), origin);
      }
    }

    const concurrencyMatch = path.match(/^\/api\/v1\/debug\/do\/([^/]+)\/concurrency-test$/);
    if (concurrencyMatch && method === "POST") {
      return addCors(await this.handleConcurrencyTest(concurrencyMatch[1]), origin);
    }

    // PUBLIC API ROUTES

    if (method === "POST" && path === "/api/v1/incidents") {
      const body = await request.json().catch(() => ({})) as { title?: string; summary?: string };
      const result = await createIncident(this.env as any, this.env.incidentiq_db, body, getAuthUser(request));
      return addCors(result, origin);
    }

    const eventsMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/events$/);
    if (eventsMatch) {
      const incidentId = eventsMatch[1];
      const body = await request.json().catch(() => ({})) as any;
      const result = await addEvent(this.env as any, this.env.incidentiq_db, incidentId, body, getAuthUser(request));
      return addCors(result, origin);
    }

    const reportMatch = method === "GET" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/report$/);
    if (reportMatch) {
      const result = await getReport(this.env as any, this.env.incidentiq_db, reportMatch[1]);
      return addCors(result, origin);
    }

    const incidentMatch = method === "GET" && path.match(/^\/api\/v1\/incidents\/([^/]+)$/);
    if (incidentMatch) {
      const result = await getIncident(this.env as any, this.env.incidentiq_db, incidentMatch[1]);
      return addCors(result, origin);
    }

    return addCors(jsonError("NOT_FOUND", "Not found", 404), origin);
  }

  private async handlePingAll(): Promise<Response> {
    const results: Record<string, string> = {};
    for (const [name, agent] of Object.entries({
      "timeline-agent": this.env.TIMELINE_AGENT,
      "rootcause-agent": this.env.ROOTCAUSE_AGENT,
      "prevention-agent": this.env.PREVENTION_AGENT,
      "moderator-agent": this.env.MODERATOR_AGENT,
    })) {
      try {
        results[name] = await agent.ping();
      } catch (err) {
        results[name] = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const allOk = Object.values(results).every((v) => v === "pong");
    return json(
      { data: { status: allOk ? "ok" : "degraded", agents: results } },
      allOk ? 200 : 503
    );
  }

  private async handleDebugCallLLM(url: URL): Promise<Response> {
    const input = url.searchParams.get("input") || "Reply with the single word: pong";
    try {
      const result = await this.env.TIMELINE_AGENT.debugCallLLM(input);
      return json({ data: result });
    } catch (err) {
      return jsonError("RPC_ERROR", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleDoCreate(): Promise<Response> {
    const id = crypto.randomUUID();
    const room = getRoom(this.env, id);
    const data: IncidentDataLoose = await room.getData() as any;
    return json({ data: { id, state: data.state, version: data.version } }, 201);
  }

  private async handleDoGet(id: string): Promise<Response> {
    try {
      const room = getRoom(this.env, id);
      const state: { state: IncidentState; version: number } = await room.getState() as any;
      const data: IncidentDataLoose = await room.getData() as any;
      return json({
        data: {
          id,
          state: state.state,
          version: state.version,
          incident: data.incident,
          eventsCount: data.events.length,
        },
      });
    } catch {
      return jsonError("NOT_FOUND", "Incident not found", 404);
    }
  }

  private async handleDoTransition(id: string, target?: string): Promise<Response> {
    if (!target) return jsonError("BAD_REQUEST", "transition field required");
    if (!isValidState(target)) return jsonError("BAD_REQUEST", `Unknown state: ${target}`);

    try {
      const room = getRoom(this.env, id);
      const result: TransitionResultLoose = await room.transition(target as IncidentState) as any;
      if (result.success) {
        return json({ data: { state: result.state, version: result.version } });
      }
      return json({ error: { code: "ILLEGAL_TRANSITION", message: result.error } }, 409);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleConcurrencyTest(id: string): Promise<Response> {
    const room = getRoom(this.env, id);
    const initial: { state: IncidentState; version: number } = await room.getState() as any;

    const results = await Promise.allSettled([
      (room.transition("Finalized" as IncidentState) as any),
      (room.transition("Finalized" as IncidentState) as any),
    ]);

    const successes = results.filter(
      (r) => r.status === "fulfilled" && (r.value as any).success
    ).length;
    const finalState: { state: IncidentState; version: number } = await room.getState() as any;

    return json({
      data: {
        initial,
        final: finalState,
        totalAttempts: 2,
        successes,
        concurrencyGuaranteeHeld: successes === 1,
        details: results.map((r) =>
          r.status === "fulfilled" ? r.value : { error: r.reason?.toString() }
        ),
      },
    });
  }
}

function isValidState(s: string): s is IncidentState {
  return ["Ingested", "TimelineDone", "Validated", "RootCauseDone", "PreventionDone", "AwaitReview", "Finalized"].includes(s);
}
