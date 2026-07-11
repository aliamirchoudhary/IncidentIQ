import { WorkerEntrypoint } from "cloudflare:workers";
import { IncidentRoom, type IncidentState } from "./incident-room";
import { createIncident, addEvent, getIncident, getReport, logActivity } from "./ingestion";

export { IncidentRoom };

interface AgentRPC {
  ping(): Promise<string>;
}

interface TimelineEventInput {
  timestamp: string | null;
  detail: string;
  source?: string;
}

interface TimelineInput {
  incident_id: string;
  raw_events: TimelineEventInput[];
}

interface TimelineAgentRPC extends AgentRPC {
  debugCallLLM(input: string): Promise<unknown>;
  generateTimeline(input: TimelineInput): Promise<unknown>;
}

interface Env {
  TIMELINE_AGENT: DurableObjectNamespace;
  ROOTCAUSE_AGENT: DurableObjectNamespace;
  PREVENTION_AGENT: DurableObjectNamespace;
  MODERATOR_AGENT: DurableObjectNamespace;
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

function getAuthUser(_request: Request): { id: string } | null {
  return null;
}

function getRoom(env: Env, id: string): DurableObjectStub<IncidentRoom> {
  const doId = env.INCIDENT_ROOM.idFromName(id);
  return env.INCIDENT_ROOM.get(doId);
}

function getAgentStub(ns: DurableObjectNamespace): DurableObjectStub {
  return ns.get(ns.idFromName("default"));
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

    const analyzeMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/analyze$/);
    if (analyzeMatch) {
      return addCors(await this.handleAnalyze(analyzeMatch[1]), origin);
    }

    return addCors(jsonError("NOT_FOUND", "Not found", 404), origin);
  }

  private agentStubs(): Array<[string, DurableObjectStub]> {
    return [
      ["timeline-agent", getAgentStub(this.env.TIMELINE_AGENT)],
      ["rootcause-agent", getAgentStub(this.env.ROOTCAUSE_AGENT)],
      ["prevention-agent", getAgentStub(this.env.PREVENTION_AGENT)],
      ["moderator-agent", getAgentStub(this.env.MODERATOR_AGENT)],
    ];
  }

  private async handlePingAll(): Promise<Response> {
    const results: Record<string, string> = {};
    for (const [name, stub] of this.agentStubs()) {
      try {
        results[name] = await (stub as unknown as AgentRPC).ping();
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
      const stub = getAgentStub(this.env.TIMELINE_AGENT) as unknown as TimelineAgentRPC;
      const result = await stub.debugCallLLM(input);
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

  private async handleAnalyze(incidentId: string): Promise<Response> {
    try {
      const room = getRoom(this.env, incidentId);

      const incident = await this.env.incidentiq_db.prepare(
        "SELECT id, title FROM incidents WHERE id = ? AND deleted_at IS NULL"
      ).bind(incidentId).first<{ id: string; title: string }>();
      if (!incident) {
        return jsonError("NOT_FOUND", "Incident not found", 404);
      }

      const state: any = await room.getState();
      if (state.state !== "Ingested") {
        return jsonError("CONFLICT", "Incident is in state \"" + state.state + "\", expected \"Ingested\"", 409);
      }

      const eventsResult = await this.env.incidentiq_db.prepare(
        "SELECT timestamp, detail, source FROM incident_events WHERE incident_id = ? ORDER BY created_at ASC"
      ).bind(incidentId).all();

      const rawEvents = (eventsResult.results ?? []).map((e: any) => ({
        timestamp: e.timestamp ?? null,
        detail: e.detail,
        source: e.source ?? undefined,
      }));

      const stub = getAgentStub(this.env.TIMELINE_AGENT) as unknown as TimelineAgentRPC;
      const result: any = await stub.generateTimeline({ incident_id: incidentId, raw_events: rawEvents });

      if (result.status !== "success" || !result.timeline) {
        await logActivity(
          this.env.incidentiq_db, incidentId, "TimelineAgent", crypto.randomUUID(),
          state.version, "completed", "failure", result.error ?? "Unknown error",
        );
        return jsonError("AGENT_ERROR", result.error ?? "TimelineAgent failed to generate timeline", 500);
      }

      const now = new Date().toISOString();
      for (const entry of result.timeline) {
        await this.env.incidentiq_db.prepare(
          "INSERT INTO timeline_entries (id, incident_id, time, event, confidence, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), incidentId, entry.time, entry.event, entry.confidence, entry.note ?? null, now).run();
      }

      await (room as any).setAgentResult("timeline", result.timeline);

      const transitionResult: any = await room.transition("TimelineDone" as IncidentState);
      if (!transitionResult.success) {
        return jsonError("INTERNAL", transitionResult.error ?? "State transition failed", 500);
      }

      await logActivity(
        this.env.incidentiq_db, incidentId, "TimelineAgent", crypto.randomUUID(),
        transitionResult.version, "completed", "success",
        "Timeline generated with " + result.timeline.length + " entries",
      );

      return json({
        data: {
          incidentId,
          status: "success",
          state: "TimelineDone",
          version: transitionResult.version,
          timeline: result.timeline,
          provider: result.provider_used ?? null,
          route: result.route_used ?? null,
        },
      }, 200);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }
}

function isValidState(s: string): s is IncidentState {
  return ["Ingested", "TimelineDone", "Validated", "RootCauseDone", "PreventionDone", "AwaitReview", "Finalized"].includes(s);
}
