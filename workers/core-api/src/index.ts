import { WorkerEntrypoint } from "cloudflare:workers";
import { IncidentRoom, type IncidentState } from "./incident-room";

export { IncidentRoom };

interface Env {
  TIMELINE_AGENT: { ping(): Promise<string> };
  ROOTCAUSE_AGENT: { ping(): Promise<string> };
  PREVENTION_AGENT: { ping(): Promise<string> };
  MODERATOR_AGENT: { ping(): Promise<string> };
  INCIDENT_ROOM: DurableObjectNamespace<IncidentRoom>;
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

function getRoom(env: Env, id: string): DurableObjectStub<IncidentRoom> {
  const doId = env.INCIDENT_ROOM.idFromName(id);
  return env.INCIDENT_ROOM.get(doId);
}

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "GET" && url.pathname === "/api/v1/debug/ping-all") {
      return this.handlePingAll();
    }

    if (method === "POST" && url.pathname === "/api/v1/debug/do/create") {
      return this.handleDoCreate();
    }

    const doMatch = url.pathname.match(/^\/api\/v1\/debug\/do\/([^/]+)$/);
    if (doMatch) {
      const id = doMatch[1];
      if (method === "GET") return this.handleDoGet(id);
      if (method === "POST") {
        const body = await request.json().catch(() => ({})) as { transition?: string };
        return this.handleDoTransition(id, body.transition);
      }
    }

    const concurrencyMatch = url.pathname.match(/^\/api\/v1\/debug\/do\/([^/]+)\/concurrency-test$/);
    if (concurrencyMatch && method === "POST") {
      return this.handleConcurrencyTest(concurrencyMatch[1]);
    }

    return jsonError("NOT_FOUND", "Not found", 404);
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

