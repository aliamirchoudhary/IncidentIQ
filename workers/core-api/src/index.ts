import { WorkerEntrypoint } from "cloudflare:workers";
import { IncidentRoom, type IncidentState } from "./incident-room";
import { createIncident, addEvent, getIncident, getReport, logActivity } from "./ingestion";
import { validateTimeline } from "./validation";
import { ingestDocument, ingestFinalizedIncident, deleteDocumentSource, restoreDocumentSource, retrieveRelevantKnowledge, getSeedDocuments } from "./rag";

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
  request_id: string;
  raw_events: TimelineEventInput[];
}

interface TimelineAgentRPC extends AgentRPC {
  debugCallLLM(input: string): Promise<unknown>;
  generateTimeline(input: TimelineInput): Promise<unknown>;
}

interface RootCauseInput {
  incident_id: string;
  request_id: string;
  timeline: Array<{ time: string; event: string; confidence: number; note?: string }>;
  retrieved_context: Array<{ chunk_id: string; title: string; content: string; score: number }>;
  confidence_threshold_override?: number;
}

interface RootCauseOutput {
  status: string;
  cause?: string;
  confidence?: number;
  evidence?: string;
  tool_invocations?: Array<{ tool: string; input: object; output: object }>;
  needs_review?: boolean;
  error?: string;
  provider_used?: string;
  route_used?: string;
}

interface RootCauseAgentRPC extends AgentRPC {
  analyzeRootCause(input: RootCauseInput): Promise<RootCauseOutput>;
}

interface PreventionInput {
  incident_id: string;
  request_id: string;
  root_cause: string;
  root_cause_evidence: string;
  retrieved_context: Array<{ chunk_id: string; title: string; content: string; score: number }>;
}

interface PreventionOutput {
  status: string;
  recommendations?: Array<{ recommendation: string; reference: string | null }>;
  error?: string;
  provider_used?: string;
  route_used?: string;
}

interface PreventionAgentRPC extends AgentRPC {
  generatePrevention(input: PreventionInput): Promise<PreventionOutput>;
}

interface ModeratorInput {
  incident_id: string;
  request_id: string;
  timeline: Array<{ time: string; event: string; confidence: number; note?: string }>;
  root_cause: { cause: string; confidence: number; evidence: string; needs_review: boolean };
  recommendations: Array<{ recommendation: string; reference: string | null }>;
}

interface ModeratorOutput {
  status: string;
  report?: {
    summary: string;
    timeline: Array<{ time: string; event: string; confidence: number; note?: string }>;
    root_cause: { cause: string; confidence: number; evidence: string; needs_review: boolean };
    recommendations: Array<{ recommendation: string; reference: string | null }>;
    needs_review: boolean;
  };
  error?: string;
  provider_used?: string;
  route_used?: string;
}

interface ModeratorAgentRPC extends AgentRPC {
  generateReport(input: ModeratorInput): Promise<ModeratorOutput>;
}

interface Env {
  TIMELINE_AGENT: DurableObjectNamespace;
  ROOTCAUSE_AGENT: DurableObjectNamespace;
  PREVENTION_AGENT: DurableObjectNamespace;
  MODERATOR_AGENT: DurableObjectNamespace;
  INCIDENT_ROOM: DurableObjectNamespace<IncidentRoom>;
  incidentiq_db: D1Database;
  AI: any;
  AUTH_BOOTSTRAP_KEY?: string;
  ALLOWED_ORIGINS?: string;
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

function getAllowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS;
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ["http://localhost:5173", "http://localhost:8787", "http://127.0.0.1:8787"];
}

function corsHeaders(origin: string, env: Env): Record<string, string> {
  const allowed = getAllowedOrigins(env);
  const validOrigin = origin !== "*" && allowed.some((a) => a === origin) ? origin : allowed[0] ?? "http://localhost:5173";
  return {
    "Access-Control-Allow-Origin": validOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function addCors(response: Response, origin: string, env: Env): Response {
  const headers = new Headers(response.headers);
  const allowed = getAllowedOrigins(env);
  const validOrigin = origin !== "*" && allowed.some((a) => a === origin) ? origin : allowed[0] ?? "http://localhost:5173";
  headers.set("Access-Control-Allow-Origin", validOrigin);
  headers.set("Vary", "Origin");
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

async function getAuthUser(request: Request, db: D1Database): Promise<{ id: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  try {
    const row = await db.prepare(
      "SELECT user_id, expires_at FROM sessions WHERE token = ?"
    ).bind(token).first<{ user_id: string; expires_at: string }>();
    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    return { id: row.user_id };
  } catch {
    return null;
  }
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
      return new Response(null, { status: 204, headers: corsHeaders(origin, this.env) });
    }

    const path = url.pathname;

    // AUTH — public (bootstrap)
    if (method === "POST" && path === "/api/v1/auth/token") {
      return addCors(await this.handleAuthToken(request), origin, this.env);
    }

    // Require auth for all remaining endpoints
    const authUser = await getAuthUser(request, this.env.incidentiq_db);
    const requireAuth = () => authUser ?? null;
    const isMutating = method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
    if (isMutating && !authUser && path.startsWith("/api/v1/") && !path.startsWith("/api/v1/auth/")) {
      return addCors(jsonError("UNAUTHORIZED", "Authentication required", 401), origin, this.env);
    }

    if (method === "GET" && path === "/api/v1/debug/ping-all") {
      return addCors(await this.handlePingAll(), origin, this.env);
    }

    if (method === "POST" && path === "/api/v1/debug/do/create") {
      return addCors(await this.handleDoCreate(), origin, this.env);
    }

    if (method === "GET" && path === "/api/v1/debug/call-llm") {
      return addCors(await this.handleDebugCallLLM(url), origin, this.env);
    }

    const doMatch = path.match(/^\/api\/v1\/debug\/do\/([^/]+)$/);
    if (doMatch) {
      const id = doMatch[1];
      if (method === "GET") return addCors(await this.handleDoGet(id), origin, this.env);
      if (method === "POST") {
        const body = await request.json().catch(() => ({})) as { transition?: string };
        return addCors(await this.handleDoTransition(id, body.transition), origin, this.env);
      }
    }

    const concurrencyMatch = path.match(/^\/api\/v1\/debug\/do\/([^/]+)\/concurrency-test$/);
    if (concurrencyMatch && method === "POST") {
      return addCors(await this.handleConcurrencyTest(concurrencyMatch[1]), origin, this.env);
    }

    // PUBLIC API ROUTES

    if (method === "POST" && path === "/api/v1/incidents") {
      const body = await request.json().catch(() => ({})) as { title?: string; summary?: string };
      const result = await createIncident(this.env as any, this.env.incidentiq_db, body, requireAuth());
      return addCors(result, origin, this.env);
    }

    const eventsMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/events$/);
    if (eventsMatch) {
      const incidentId = eventsMatch[1];
      const body = await request.json().catch(() => ({})) as any;
      const result = await addEvent(this.env as any, this.env.incidentiq_db, incidentId, body, requireAuth());
      return addCors(result, origin, this.env);
    }

    const reportMatch = method === "GET" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/report$/);
    if (reportMatch) {
      const result = await getReport(this.env as any, this.env.incidentiq_db, reportMatch[1]);
      return addCors(result, origin, this.env);
    }

    const similarMatch = method === "GET" && path === "/api/v1/incidents/similar";
    if (similarMatch) {
      return addCors(await this.handleSimilar(url), origin, this.env);
    }

    const incidentMatch = method === "GET" && path.match(/^\/api\/v1\/incidents\/([^/]+)$/);
    if (incidentMatch) {
      const result = await getIncident(this.env as any, this.env.incidentiq_db, incidentMatch[1]);
      return addCors(result, origin, this.env);
    }

    const analyzeMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/analyze$/);
    if (analyzeMatch) {
      return addCors(await this.handleAnalyze(analyzeMatch[1]), origin, this.env);
    }

    const rootcauseMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/analyze-rootcause$/);
    if (rootcauseMatch) {
      const body = await request.json().catch(() => ({})) as any;
      return addCors(await this.handleRootCause(rootcauseMatch[1], body), origin, this.env);
    }

    const preventionMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/analyze-prevention$/);
    if (preventionMatch) {
      return addCors(await this.handlePrevention(preventionMatch[1]), origin, this.env);
    }

    const moderateMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/analyze-moderate$/);
    if (moderateMatch) {
      return addCors(await this.handleModerate(moderateMatch[1]), origin, this.env);
    }

    const reviewMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/review$/);
    if (reviewMatch) {
      const body = await request.json().catch(() => ({})) as any;
      return addCors(await this.handleReview(reviewMatch[1], body), origin, this.env);
    }

    const userGetPrefs = method === "GET" && path.match(/^\/api\/v1\/users\/([^/]+)\/preferences$/);
    if (userGetPrefs) {
      return addCors(await this.handleGetPreferences(userGetPrefs[1]), origin, this.env);
    }

    const userPutPrefs = method === "PUT" && path.match(/^\/api\/v1\/users\/([^/]+)\/preferences$/);
    if (userPutPrefs) {
      const body = await request.json().catch(() => ({})) as any;
      return addCors(await this.handlePutPreferences(userPutPrefs[1], body), origin, this.env);
    }

    // KNOWLEDGE / RAG ROUTES

    if (method === "POST" && path === "/api/v1/knowledge/seed") {
      return addCors(await this.handleKnowledgeSeed(), origin, this.env);
    }

    if (method === "POST" && path === "/api/v1/knowledge/ingest") {
      const body = await request.json().catch(() => ({})) as any;
      return addCors(await this.handleKnowledgeIngest(body), origin, this.env);
    }

    if (method === "GET" && path === "/api/v1/knowledge/query") {
      return addCors(await this.handleKnowledgeQuery(url), origin, this.env);
    }

    const deleteMatch = method === "DELETE" && path.match(/^\/api\/v1\/knowledge\/sources\/([^/]+)$/);
    if (deleteMatch) {
      return addCors(await this.handleKnowledgeDelete(deleteMatch[1]), origin, this.env);
    }

    const restoreMatch = method === "PATCH" && path.match(/^\/api\/v1\/knowledge\/sources\/([^/]+)\/restore$/);
    if (restoreMatch) {
      return addCors(await this.handleKnowledgeRestore(restoreMatch[1]), origin, this.env);
    }

    return addCors(jsonError("NOT_FOUND", "Not found", 404), origin, this.env);
  }

  private agentStubs(): Array<[string, DurableObjectStub]> {
    return [
      ["timeline-agent", getAgentStub(this.env.TIMELINE_AGENT)],
      ["rootcause-agent", getAgentStub(this.env.ROOTCAUSE_AGENT)],
      ["prevention-agent", getAgentStub(this.env.PREVENTION_AGENT)],
      ["moderator-agent", getAgentStub(this.env.MODERATOR_AGENT)],
    ];
  }

  private async handleAuthToken(request: Request): Promise<Response> {
    try {
      const body = await request.json().catch(() => ({})) as any;
      if (!body.user_id || typeof body.user_id !== "string") {
        return jsonError("VALIDATION_ERROR", "user_id is required", 400);
      }
      const bootstrapKey = this.env.AUTH_BOOTSTRAP_KEY;
      if (bootstrapKey) {
        if (!body.bootstrap_key || body.bootstrap_key !== bootstrapKey) {
          return jsonError("UNAUTHORIZED", "Invalid bootstrap key", 401);
        }
      }
      const user = await this.env.incidentiq_db.prepare(
        "SELECT id FROM users WHERE id = ?"
      ).bind(body.user_id).first<{ id: string }>();
      if (!user) {
        return jsonError("NOT_FOUND", "User not found", 404);
      }
      const token = crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      await this.env.incidentiq_db.prepare(
        "INSERT INTO sessions (id, user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), user.id, token, expiresAt.toISOString(), now.toISOString()).run();
      return json({ data: { user_id: user.id, token, expires_at: expiresAt.toISOString() } });
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
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
      const requestId = crypto.randomUUID();
      const room = getRoom(this.env, incidentId);

      const incident = await this.env.incidentiq_db.prepare(
        "SELECT id FROM incidents WHERE id = ? AND deleted_at IS NULL"
      ).bind(incidentId).first<{ id: string }>();
      if (!incident) {
        return jsonError("NOT_FOUND", "Incident not found", 404);
      }

      const state: any = await room.getState();
      if (state.state !== "Ingested" && state.state !== "TimelineDone") {
        return jsonError("CONFLICT", "Incident is in state \"" + state.state + "\", expected \"Ingested\" or \"TimelineDone\"", 409);
      }

      this.ctx.waitUntil(this.runFullChain(incidentId, requestId));

      return json({
        data: {
          incidentId,
          status: "processing",
          state: state.state,
        },
      }, 202);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async runFullChain(incidentId: string, requestId: string): Promise<void> {
    try {
      const room = getRoom(this.env, incidentId);
      const state: any = await room.getState();
      const isRetrigger = state.state === "TimelineDone";

      const eventsResult = await this.env.incidentiq_db.prepare(
        "SELECT timestamp, detail, source FROM incident_events WHERE incident_id = ? ORDER BY created_at ASC"
      ).bind(incidentId).all();

      const rawEvents = (eventsResult.results ?? []).map((e: any) => ({
        timestamp: e.timestamp ?? null,
        detail: e.detail,
        source: e.source ?? undefined,
      }));

      // ---- STEP 1: Timeline Agent ----
      const t0 = performance.now();
      logJson(incidentId, requestId, "CoreApi", state.version, "started", "pending", "Calling TimelineAgent");
      const timelineStub = getAgentStub(this.env.TIMELINE_AGENT) as unknown as TimelineAgentRPC;
      const timelineResult: any = await timelineStub.generateTimeline({ incident_id: incidentId, request_id: requestId, raw_events: rawEvents });
      const t1 = performance.now();

      if (timelineResult.status !== "success" || !timelineResult.timeline) {
        const latency = Math.round(t1 - t0);
        logJson(incidentId, requestId, "CoreApi", state.version, "completed", "failure", "TimelineAgent failed: " + (timelineResult.error ?? "Unknown error"), { latency_ms: latency });
        await logActivity(
          this.env.incidentiq_db, incidentId, "TimelineAgent", requestId,
          state.version, "completed", "failure", timelineResult.error ?? "Unknown error",
        );
        return;
      }

      if (isRetrigger) {
        await this.env.incidentiq_db.prepare(
          "DELETE FROM timeline_entries WHERE incident_id = ?"
        ).bind(incidentId).run();
      }

      const now = new Date().toISOString();
      for (const entry of timelineResult.timeline) {
        await this.env.incidentiq_db.prepare(
          "INSERT INTO timeline_entries (id, incident_id, time, event, confidence, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), incidentId, entry.time, entry.event, entry.confidence, entry.note ?? null, now).run();
      }

      await (room as any).setAgentResult("timeline", timelineResult.timeline);

      let currentVersion = state.version;
      if (!isRetrigger) {
        const tResult: any = await room.transition("TimelineDone" as IncidentState);
        if (tResult.success) currentVersion = tResult.version;
      }

      const timelineLatency = Math.round(t1 - t0);
      logJson(incidentId, requestId, "CoreApi", currentVersion, "completed", "success",
        "TimelineAgent completed with " + timelineResult.timeline.length + " entries",
        { latency_ms: timelineLatency, agent_latency_ms: timelineLatency, provider: timelineResult.provider_used ?? null });
      await logActivity(
        this.env.incidentiq_db, incidentId, "TimelineAgent", requestId,
        currentVersion, "completed", "success",
        "Timeline generated with " + timelineResult.timeline.length + " entries",
      );

      // ---- STEP 2: Validation Gate ----
      const v0 = performance.now();
      logJson(incidentId, requestId, "CoreApi", currentVersion, "started", "pending", "Running ValidationGate");
      const validation = validateTimeline(timelineResult.timeline, rawEvents);

      if (!validation.valid) {
        await (room as any).setValidationStatus(validation.issues);
        const issuesSummary = validation.issues.map((i: any) => "- " + i.detail).join("\n");
        await this.env.incidentiq_db.prepare(
          "INSERT INTO conversations (id, incident_id, author, message, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), incidentId, "agent", issuesSummary, "validation", now).run();
        logJson(incidentId, requestId, "CoreApi", currentVersion, "completed", "invalid",
          "Validation failed: " + validation.issues.map((i: any) => i.type + ": " + i.detail).join("; "),
          { latency_ms: Math.round(performance.now() - v0) });
        await logActivity(
          this.env.incidentiq_db, incidentId, "ValidationGate", requestId,
          currentVersion, "completed", "invalid",
          "Validation failed: " + validation.issues.map((i: any) => i.type + ": " + i.detail).join("; "),
        );
        return;
      }

      const validatedTransition: any = await room.transition("Validated" as IncidentState);
      if (!validatedTransition.success) return;
      currentVersion = validatedTransition.version;
      await (room as any).setValidationStatus(null);

      logJson(incidentId, requestId, "CoreApi", currentVersion, "completed", "valid",
        "Validation passed: " + timelineResult.timeline.length + " timeline entries checked",
        { latency_ms: Math.round(performance.now() - v0) });
      await logActivity(
        this.env.incidentiq_db, incidentId, "ValidationGate", requestId,
        currentVersion, "completed", "valid",
        "Validation passed: " + timelineResult.timeline.length + " timeline entries checked",
      );

      // ---- STEP 3: Root Cause Agent ----
      const timeline = (timelineResult.timeline as Array<any>).map((e: any) => ({
        time: e.time,
        event: e.event,
        confidence: e.confidence,
        note: e.note ?? undefined,
      }));

      const queryText = timeline.map((e: any) => e.event).join(" ");
      let retrieved_context: Array<{ chunk_id: string; title: string; content: string; score: number }> = [];
      try {
        const rawContext = await retrieveRelevantKnowledge(queryText, this.env.incidentiq_db, this.env.AI, 3);
        retrieved_context = rawContext.map((c: any) => ({
          chunk_id: c.chunkId,
          title: c.title,
          content: c.content,
          score: c.score,
        }));
      } catch (err) {
        logJson(incidentId, requestId, "KnowledgeRetrieval", currentVersion, "completed", "degraded",
          "Knowledge retrieval failed: " + (err instanceof Error ? err.message : String(err)));
        await logActivity(
          this.env.incidentiq_db, incidentId, "KnowledgeRetrieval", requestId,
          currentVersion, "completed", "degraded",
          "Knowledge retrieval failed, proceeding with empty context: " + (err instanceof Error ? err.message : String(err)),
        );
      }

      const rc0 = performance.now();
      logJson(incidentId, requestId, "CoreApi", currentVersion, "started", "pending", "Calling RootCauseAgent");
      const rcStub = getAgentStub(this.env.ROOTCAUSE_AGENT) as unknown as RootCauseAgentRPC;
      const rcResult: RootCauseOutput = await rcStub.analyzeRootCause({
        incident_id: incidentId, request_id: requestId, timeline, retrieved_context,
      });
      const rc1 = performance.now();

      if (rcResult.status !== "success" || !rcResult.cause) {
        logJson(incidentId, requestId, "CoreApi", currentVersion, "completed", "failure",
          "RootCauseAgent failed: " + (rcResult.error ?? "Unknown error"),
          { latency_ms: Math.round(rc1 - rc0) });
        await logActivity(
          this.env.incidentiq_db, incidentId, "RootCauseAgent", requestId,
          currentVersion, "completed", "failure", rcResult.error ?? "RootCauseAgent failed",
        );
        return;
      }

      if (isRetrigger) {
        await this.env.incidentiq_db.prepare(
          "DELETE FROM root_causes WHERE incident_id = ?"
        ).bind(incidentId).run();
      }

      const rootCauseId = crypto.randomUUID();
      await this.env.incidentiq_db.prepare(
        "INSERT OR REPLACE INTO root_causes (id, incident_id, cause, confidence, evidence, needs_review, provider_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        rootCauseId, incidentId, rcResult.cause, rcResult.confidence ?? 0,
        rcResult.evidence ?? null, rcResult.needs_review ? 1 : 0,
        rcResult.provider_used ?? null, now,
      ).run();

      const rcTransition: any = await room.transition("RootCauseDone" as IncidentState);
      if (!rcTransition.success) return;
      currentVersion = rcTransition.version;

      const rcLatency = Math.round(rc1 - rc0);
      logJson(incidentId, requestId, "CoreApi", currentVersion, "completed", "success",
        "RootCauseAgent completed: " + rcResult.cause,
        { latency_ms: rcLatency, agent_latency_ms: rcLatency, provider: rcResult.provider_used ?? null });
      await logActivity(
        this.env.incidentiq_db, incidentId, "RootCauseAgent", requestId,
        currentVersion, "completed", "success",
        "Root cause: " + rcResult.cause,
      );

      // ---- STEP 4: Prevention Agent ----
      const rootCauseRow = await this.env.incidentiq_db.prepare(
        "SELECT cause, evidence FROM root_causes WHERE incident_id = ?"
      ).bind(incidentId).first<{ cause: string; evidence: string | null }>();
      if (!rootCauseRow) return;

      let preventionContext: Array<{ chunk_id: string; title: string; content: string; score: number }> = [];
      try {
        const rawPreventionContext = await retrieveRelevantKnowledge(rootCauseRow.cause, this.env.incidentiq_db, this.env.AI, 3);
        preventionContext = rawPreventionContext.map((c: any) => ({
          chunk_id: c.chunkId,
          title: c.title,
          content: c.content,
          score: c.score,
        }));
      } catch (err) {
        logJson(incidentId, requestId, "KnowledgeRetrieval", currentVersion, "completed", "degraded",
          "Prevention knowledge retrieval degraded: " + (err instanceof Error ? err.message : String(err)));
        await logActivity(
          this.env.incidentiq_db, incidentId, "KnowledgeRetrieval", requestId,
          currentVersion, "completed", "degraded",
          "Prevention knowledge retrieval degraded: " + (err instanceof Error ? err.message : String(err)),
        );
      }

      const p0 = performance.now();
      logJson(incidentId, requestId, "CoreApi", currentVersion, "started", "pending", "Calling PreventionAgent");
      const prevStub = getAgentStub(this.env.PREVENTION_AGENT) as unknown as PreventionAgentRPC;
      const prevResult: PreventionOutput = await prevStub.generatePrevention({
        incident_id: incidentId,
        request_id: requestId,
        root_cause: rootCauseRow.cause,
        root_cause_evidence: rootCauseRow.evidence ?? "",
        retrieved_context: preventionContext,
      });
      const p1 = performance.now();

      if (prevResult.status !== "success" || !prevResult.recommendations) {
        logJson(incidentId, requestId, "CoreApi", currentVersion, "completed", "failure",
          "PreventionAgent failed: " + (prevResult.error ?? "Unknown error"),
          { latency_ms: Math.round(p1 - p0) });
        await logActivity(
          this.env.incidentiq_db, incidentId, "PreventionAgent", requestId,
          currentVersion, "completed", "failure", prevResult.error ?? "PreventionAgent failed",
        );
        return;
      }

      if (isRetrigger) {
        await this.env.incidentiq_db.prepare(
          "DELETE FROM recommendations WHERE incident_id = ?"
        ).bind(incidentId).run();
      }

      for (const rec of prevResult.recommendations) {
        await this.env.incidentiq_db.prepare(
          "INSERT INTO recommendations (id, incident_id, recommendation, reference, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), incidentId, rec.recommendation, rec.reference ?? null, now).run();
      }

      const prevTransition: any = await room.transition("PreventionDone" as IncidentState);
      if (!prevTransition.success) return;
      currentVersion = prevTransition.version;

      const prevLatency = Math.round(p1 - p0);
      logJson(incidentId, requestId, "CoreApi", currentVersion, "completed", "success",
        "PreventionAgent completed with " + prevResult.recommendations.length + " recommendations",
        { latency_ms: prevLatency, agent_latency_ms: prevLatency, provider: prevResult.provider_used ?? null });
      await logActivity(
        this.env.incidentiq_db, incidentId, "PreventionAgent", requestId,
        currentVersion, "completed", "success",
        prevResult.recommendations.length + " recommendations generated",
      );

      // ---- STEP 5: Moderator Agent ----
      const rcFull = await this.env.incidentiq_db.prepare(
        "SELECT cause, confidence, evidence, needs_review FROM root_causes WHERE incident_id = ?"
      ).bind(incidentId).first<{ cause: string; confidence: number; evidence: string | null; needs_review: number }>();
      if (!rcFull) return;

      const recsResult = await this.env.incidentiq_db.prepare(
        "SELECT recommendation, reference FROM recommendations WHERE incident_id = ? ORDER BY rowid ASC"
      ).bind(incidentId).all();

      const recommendations = (recsResult.results ?? []).map((r: any) => ({
        recommendation: r.recommendation,
        reference: r.reference ?? null,
      }));

      const m0 = performance.now();
      logJson(incidentId, requestId, "CoreApi", currentVersion, "started", "pending", "Calling ModeratorAgent");
      const modStub = getAgentStub(this.env.MODERATOR_AGENT) as unknown as ModeratorAgentRPC;
      const modResult: ModeratorOutput = await modStub.generateReport({
        incident_id: incidentId,
        request_id: requestId,
        timeline,
        root_cause: {
          cause: rcFull.cause,
          confidence: rcFull.confidence,
          evidence: rcFull.evidence ?? "",
          needs_review: rcFull.needs_review === 1,
        },
        recommendations,
      });
      const m1 = performance.now();

      if (modResult.status !== "success" || !modResult.report) {
        logJson(incidentId, requestId, "CoreApi", currentVersion, "completed", "failure",
          "ModeratorAgent failed: " + (modResult.error ?? "Unknown error"),
          { latency_ms: Math.round(m1 - m0) });
        await logActivity(
          this.env.incidentiq_db, incidentId, "ModeratorAgent", requestId,
          currentVersion, "completed", "failure", modResult.error ?? "ModeratorAgent failed",
        );
        return;
      }

      await (room as any).setAgentResult("report", modResult.report);

      const modTransition: any = await room.transition("AwaitReview" as IncidentState);
      if (!modTransition.success) return;

      const modLatency = Math.round(m1 - m0);
      logJson(incidentId, requestId, "CoreApi", modTransition.version, "completed", "success",
        "Full analysis chain complete",
        { latency_ms: modLatency, agent_latency_ms: modLatency, provider: modResult.provider_used ?? null });
      await logActivity(
        this.env.incidentiq_db, incidentId, "ModeratorAgent", requestId,
        modTransition.version, "completed", "success",
        "Draft report assembled and ready for review",
      );
    } catch (err) {
      logJson(incidentId, requestId, "AutoChain", 0, "completed", "failure",
        "Full chain failed: " + (err instanceof Error ? err.message : String(err)));
      await logActivity(
        this.env.incidentiq_db, incidentId, "AutoChain", requestId,
        0, "completed", "failure",
        "Full chain failed: " + (err instanceof Error ? err.message : String(err)),
      ).catch(() => {});
    }
  }

  private async handleRootCause(incidentId: string, body?: any): Promise<Response> {
    try {
      const requestId = crypto.randomUUID();
      const room = getRoom(this.env, incidentId);
      const incident = await this.env.incidentiq_db.prepare(
        "SELECT id FROM incidents WHERE id = ? AND deleted_at IS NULL"
      ).bind(incidentId).first<{ id: string }>();
      if (!incident) {
        return jsonError("NOT_FOUND", "Incident not found", 404);
      }

      const state: any = await room.getState();
      if (state.state !== "Validated") {
        return jsonError("CONFLICT", `Incident is in state "${state.state}", expected "Validated"`, 409);
      }

      const timelineResult = await this.env.incidentiq_db.prepare(
        "SELECT time, event, confidence, note FROM timeline_entries WHERE incident_id = ? ORDER BY time ASC"
      ).bind(incidentId).all();

      const timeline = (timelineResult.results ?? []).map((e: any) => ({
        time: e.time,
        event: e.event,
        confidence: e.confidence,
        note: e.note ?? undefined,
      }));

      if (timeline.length === 0) {
        return jsonError("CONFLICT", "No timeline entries found. Run /analyze first.", 409);
      }

      const queryText = timeline.map((e: any) => e.event).join(" ");
      let retrieved_context: Array<{ chunk_id: string; title: string; content: string; score: number }> = [];
      try {
        const rawContext = await retrieveRelevantKnowledge(queryText, this.env.incidentiq_db, this.env.AI, 3);
        retrieved_context = rawContext.map((c: any) => ({
          chunk_id: c.chunkId,
          title: c.title,
          content: c.content,
          score: c.score,
        }));
      } catch (err) {
        await logActivity(
          this.env.incidentiq_db, incidentId, "KnowledgeRetrieval", requestId,
          state.version, "completed", "degraded",
          "Knowledge retrieval failed, proceeding with empty context: " + (err instanceof Error ? err.message : String(err)),
        );
      }

      let confidenceThresholdOverride: number | undefined;
      if (body?.user_id) {
        try {
          const userRow = await this.env.incidentiq_db.prepare(
            "SELECT preferences FROM users WHERE id = ?"
          ).bind(body.user_id).first<{ preferences: string | null }>();
          if (userRow?.preferences) {
            const prefs = JSON.parse(userRow.preferences);
            if (typeof prefs.confidence_threshold_override === "number") {
              confidenceThresholdOverride = prefs.confidence_threshold_override;
            }
          }
        } catch {}
      }

      const stub = getAgentStub(this.env.ROOTCAUSE_AGENT) as unknown as RootCauseAgentRPC;
      const result: RootCauseOutput = await stub.analyzeRootCause({
        incident_id: incidentId,
        request_id: requestId,
        timeline,
        retrieved_context,
        ...(confidenceThresholdOverride !== undefined ? { confidence_threshold_override: confidenceThresholdOverride } : {}),
      });

      if (result.status !== "success" || !result.cause) {
        await logActivity(
          this.env.incidentiq_db, incidentId, "RootCauseAgent", requestId,
          state.version, "completed", "failure", result.error ?? "RootCauseAgent failed",
        );
        return jsonError("AGENT_ERROR", result.error ?? "RootCauseAgent failed to generate root cause", 500);
      }

      const now = new Date().toISOString();
      const rootCauseId = crypto.randomUUID();
      await this.env.incidentiq_db.prepare(
        "INSERT OR REPLACE INTO root_causes (id, incident_id, cause, confidence, evidence, needs_review, provider_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        rootCauseId, incidentId, result.cause, result.confidence ?? 0,
        result.evidence ?? null, result.needs_review ? 1 : 0,
        result.provider_used ?? null, now,
      ).run();

      const transitionResult: any = await room.transition("RootCauseDone" as IncidentState);
      if (!transitionResult.success) {
        return jsonError("INTERNAL", transitionResult.error ?? "State transition to RootCauseDone failed", 500);
      }

      await logActivity(
        this.env.incidentiq_db, incidentId, "RootCauseAgent", requestId,
        transitionResult.version, "completed", "success",
        "Root cause: " + result.cause,
      );

      return json({
        data: {
          incidentId,
          status: "success",
          state: "RootCauseDone",
          version: transitionResult.version,
          cause: result.cause,
          confidence: result.confidence,
          evidence: result.evidence,
          tool_invocations: result.tool_invocations ?? [],
          needs_review: result.needs_review ?? false,
          retrieved_chunks: retrieved_context.length,
          provider: result.provider_used ?? null,
          route: result.route_used ?? null,
        },
      }, 200);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handlePrevention(incidentId: string): Promise<Response> {
    try {
      const requestId = crypto.randomUUID();
      const room = getRoom(this.env, incidentId);
      const incident = await this.env.incidentiq_db.prepare(
        "SELECT id FROM incidents WHERE id = ? AND deleted_at IS NULL"
      ).bind(incidentId).first<{ id: string }>();
      if (!incident) {
        return jsonError("NOT_FOUND", "Incident not found", 404);
      }

      const state: any = await room.getState();
      if (state.state !== "RootCauseDone") {
        return jsonError("CONFLICT", `Incident is in state "${state.state}", expected "RootCauseDone"`, 409);
      }

      const rootCauseRow = await this.env.incidentiq_db.prepare(
        "SELECT cause, evidence FROM root_causes WHERE incident_id = ?"
      ).bind(incidentId).first<{ cause: string; evidence: string | null }>();
      if (!rootCauseRow) {
        return jsonError("CONFLICT", "No root cause found. Run /analyze-rootcause first.", 409);
      }

      let retrieved_context: Array<{ chunk_id: string; title: string; content: string; score: number }> = [];
      try {
        const rawContext = await retrieveRelevantKnowledge(rootCauseRow.cause, this.env.incidentiq_db, this.env.AI, 3);
        retrieved_context = rawContext.map((c: any) => ({
          chunk_id: c.chunkId, title: c.title, content: c.content, score: c.score,
        }));
      } catch (err) {
        await logActivity(
          this.env.incidentiq_db, incidentId, "KnowledgeRetrieval", requestId,
          state.version, "completed", "degraded",
          "Knowledge retrieval failed, proceeding with empty context: " + (err instanceof Error ? err.message : String(err)),
        );
      }

      const stub = getAgentStub(this.env.PREVENTION_AGENT) as unknown as PreventionAgentRPC;
      const result: PreventionOutput = await stub.generatePrevention({
        incident_id: incidentId,
        request_id: requestId,
        root_cause: rootCauseRow.cause,
        root_cause_evidence: rootCauseRow.evidence ?? "",
        retrieved_context,
      });

      if (result.status !== "success" || !result.recommendations || result.recommendations.length === 0) {
        await logActivity(
          this.env.incidentiq_db, incidentId, "PreventionAgent", requestId,
          state.version, "completed", "failure", result.error ?? "PreventionAgent failed",
        );
        return jsonError("AGENT_ERROR", result.error ?? "PreventionAgent failed to generate recommendations", 500);
      }

      const now = new Date().toISOString();
      for (const rec of result.recommendations) {
        await this.env.incidentiq_db.prepare(
          "INSERT INTO recommendations (id, incident_id, recommendation, reference, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), incidentId, rec.recommendation, rec.reference, now).run();
      }

      const transitionResult: any = await room.transition("PreventionDone" as IncidentState);
      if (!transitionResult.success) {
        return jsonError("INTERNAL", transitionResult.error ?? "State transition to PreventionDone failed", 500);
      }

      await logActivity(
        this.env.incidentiq_db, incidentId, "PreventionAgent", requestId,
        transitionResult.version, "completed", "success",
        "Generated " + result.recommendations.length + " recommendations",
      );

      return json({
        data: {
          incidentId,
          status: "success",
          state: "PreventionDone",
          version: transitionResult.version,
          recommendations: result.recommendations,
          retrieved_chunks: retrieved_context.length,
          provider: result.provider_used ?? null,
          route: result.route_used ?? null,
        },
      }, 200);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleModerate(incidentId: string): Promise<Response> {
    try {
      const requestId = crypto.randomUUID();
      const room = getRoom(this.env, incidentId);
      const incident = await this.env.incidentiq_db.prepare(
        "SELECT id FROM incidents WHERE id = ? AND deleted_at IS NULL"
      ).bind(incidentId).first<{ id: string }>();
      if (!incident) {
        return jsonError("NOT_FOUND", "Incident not found", 404);
      }

      const state: any = await room.getState();
      if (state.state !== "PreventionDone") {
        return jsonError("CONFLICT", `Incident is in state "${state.state}", expected "PreventionDone"`, 409);
      }

      const timelineResult = await this.env.incidentiq_db.prepare(
        "SELECT time, event, confidence, note FROM timeline_entries WHERE incident_id = ? ORDER BY time ASC"
      ).bind(incidentId).all();

      const timeline = (timelineResult.results ?? []).map((e: any) => ({
        time: e.time,
        event: e.event,
        confidence: e.confidence,
        note: e.note ?? undefined,
      }));

      if (timeline.length === 0) {
        return jsonError("CONFLICT", "No timeline entries found. Run /analyze first.", 409);
      }

      const rootCauseRow = await this.env.incidentiq_db.prepare(
        "SELECT cause, confidence, evidence, needs_review FROM root_causes WHERE incident_id = ?"
      ).bind(incidentId).first<{ cause: string; confidence: number; evidence: string | null; needs_review: number }>();

      if (!rootCauseRow) {
        return jsonError("CONFLICT", "No root cause found. Run /analyze-rootcause first.", 409);
      }

      const recsResult = await this.env.incidentiq_db.prepare(
        "SELECT recommendation, reference FROM recommendations WHERE incident_id = ? ORDER BY rowid ASC"
      ).bind(incidentId).all();

      const recommendations = (recsResult.results ?? []).map((r: any) => ({
        recommendation: r.recommendation,
        reference: r.reference ?? null,
      }));

      const stub = getAgentStub(this.env.MODERATOR_AGENT) as unknown as ModeratorAgentRPC;
      const result: ModeratorOutput = await stub.generateReport({
        incident_id: incidentId,
        request_id: requestId,
        timeline,
        root_cause: {
          cause: rootCauseRow.cause,
          confidence: rootCauseRow.confidence,
          evidence: rootCauseRow.evidence ?? "",
          needs_review: rootCauseRow.needs_review === 1,
        },
        recommendations,
      });

      if (result.status !== "success" || !result.report) {
        await logActivity(
          this.env.incidentiq_db, incidentId, "ModeratorAgent", requestId,
          state.version, "completed", "failure", result.error ?? "ModeratorAgent failed",
        );
        return jsonError("AGENT_ERROR", result.error ?? "ModeratorAgent failed to generate report", 500);
      }

      await (room as any).setAgentResult("report", result.report);

      const transitionResult: any = await room.transition("AwaitReview" as IncidentState);
      if (!transitionResult.success) {
        return jsonError("INTERNAL", transitionResult.error ?? "State transition to AwaitReview failed", 500);
      }

      await logActivity(
        this.env.incidentiq_db, incidentId, "ModeratorAgent", requestId,
        transitionResult.version, "completed", "success",
        "Draft report assembled and ready for review",
      );

      return json({
        data: {
          incidentId,
          status: "success",
          state: "AwaitReview",
          version: transitionResult.version,
          report: result.report,
        },
      }, 200);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleReview(incidentId: string, body: any): Promise<Response> {
    try {
      const room = getRoom(this.env, incidentId);

      const incident = await this.env.incidentiq_db.prepare(
        "SELECT id FROM incidents WHERE id = ? AND deleted_at IS NULL"
      ).bind(incidentId).first<{ id: string }>();
      if (!incident) {
        return jsonError("NOT_FOUND", "Incident not found", 404);
      }

      if (!body.reviewer_user_id || typeof body.reviewer_user_id !== "string") {
        return jsonError("VALIDATION_ERROR", "reviewer_user_id is required", 400);
      }
      if (typeof body.approved !== "boolean") {
        return jsonError("VALIDATION_ERROR", "approved (boolean) is required", 400);
      }

      const state: any = await room.getState();
      if (state.state !== "AwaitReview") {
        return jsonError("CONFLICT", `Incident is in state "${state.state}", expected "AwaitReview"`, 409);
      }

      const now = new Date().toISOString();
      const reviewId = crypto.randomUUID();

      if (body.approved) {
        const reportData = await (room as any).getData().then((d: any) => d?.report ?? null);

        let reportSummary = reportData?.summary ?? "";
        if (body.modifications && typeof body.modifications === "string") {
          reportSummary = body.modifications;
        }
        const verifiedLine = `Verified by ${body.reviewer_user_id} on ${now}`;
        reportSummary = reportSummary ? `${reportSummary}\n\n${verifiedLine}` : verifiedLine;

        await this.env.incidentiq_db.prepare(
          "INSERT INTO reviews (id, incident_id, reviewer_user_id, approved, modifications, target_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(reviewId, incidentId, body.reviewer_user_id, 1, body.modifications ?? null, "Finalized", now).run();

        await this.env.incidentiq_db.prepare(
          "INSERT INTO conversations (id, incident_id, author, message, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), incidentId, body.reviewer_user_id,
          body.modifications
            ? `Report approved with modifications: ${body.modifications}\n${verifiedLine}`
            : `Report approved. ${verifiedLine}`,
          "review", now).run();

        await (room as any).setAgentResult("report", {
          ...(reportData ?? {}),
          summary: reportSummary,
        });

        const transitionResult: any = await room.transition("Finalized" as IncidentState);
        if (!transitionResult.success) {
          return jsonError("INTERNAL", transitionResult.error ?? "State transition to Finalized failed", 500);
        }

        await logActivity(
          this.env.incidentiq_db, incidentId, "HumanReview", reviewId,
          transitionResult.version, "completed", "approved",
          body.modifications
            ? `Approved with modifications: ${body.modifications}`
            : `Approved by ${body.reviewer_user_id}`,
        );

        this.ctx.waitUntil(
          ingestFinalizedIncident(incidentId, this.env.incidentiq_db, this.env.AI).catch((err) => {
            logActivity(
              this.env.incidentiq_db, incidentId, "KnowledgeIngestion", reviewId,
              transitionResult.version, "completed", "degraded",
              "Failed to ingest finalized incident into knowledge base: " + (err instanceof Error ? err.message : String(err)),
            ).catch(() => {});
          })
        );

        return json({
          data: {
            incidentId,
            status: "success",
            action: "approved",
            state: "Finalized",
            version: transitionResult.version,
            reviewId,
          },
        }, 200);
      }

      const targetState: string = body.target_state ?? "RootCauseDone";
      if (!["TimelineDone", "RootCauseDone", "PreventionDone"].includes(targetState)) {
        return jsonError("VALIDATION_ERROR", `Invalid target_state "${targetState}". Must be one of: TimelineDone, RootCauseDone, PreventionDone`, 400);
      }

      await this.env.incidentiq_db.prepare(
        "INSERT INTO reviews (id, incident_id, reviewer_user_id, approved, modifications, target_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(reviewId, incidentId, body.reviewer_user_id, 0, body.modifications ?? null, targetState, now).run();

      await this.env.incidentiq_db.prepare(
        "INSERT INTO conversations (id, incident_id, author, message, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), incidentId, body.reviewer_user_id,
        body.modifications
          ? `Report rejected. Target state: ${targetState}. Modifications requested: ${body.modifications}`
          : `Report rejected. Target state: ${targetState}.`,
        "review", now).run();

      const transitionResult: any = await room.transition(targetState as IncidentState);
      if (!transitionResult.success) {
        return jsonError("INTERNAL", transitionResult.error ?? `State transition to ${targetState} failed`, 500);
      }

      await logActivity(
        this.env.incidentiq_db, incidentId, "HumanReview", reviewId,
        transitionResult.version, "completed", "rejected",
        body.modifications
          ? `Rejected. Target: ${targetState}. Modifications: ${body.modifications}`
          : `Rejected by ${body.reviewer_user_id}. Target: ${targetState}`,
      );

      return json({
        data: {
          incidentId,
          status: "success",
          action: "rejected",
          state: targetState,
          version: transitionResult.version,
          reviewId,
        },
      }, 200);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleSimilar(url: URL): Promise<Response> {
    try {
      const q = url.searchParams.get("query");
      if (!q || q.trim().length === 0) {
        return jsonError("VALIDATION_ERROR", "query parameter 'query' is required", 400);
      }

      const k = Math.min(Math.max(parseInt(url.searchParams.get("k") ?? "5", 10) || 5, 1), 20);
      const results = await retrieveRelevantKnowledge(q.trim(), this.env.incidentiq_db, this.env.AI, k);

      const pastIncidents = results.filter((r) => r.type === "past_incident" || r.sourceId !== undefined);

      return json({ data: { query: q, k, results: pastIncidents } });
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleGetPreferences(userId: string): Promise<Response> {
    try {
      const user = await this.env.incidentiq_db.prepare(
        "SELECT id, email, name, preferences FROM users WHERE id = ?"
      ).bind(userId).first<{ id: string; email: string; name: string; preferences: string | null }>();

      if (!user) {
        return jsonError("NOT_FOUND", "User not found", 404);
      }

      let parsed: any = {};
      if (user.preferences) {
        try { parsed = JSON.parse(user.preferences); } catch {}
      }

      return json({
        data: {
          userId: user.id,
          email: user.email,
          name: user.name,
          preferences: parsed,
        },
      });
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handlePutPreferences(userId: string, body: any): Promise<Response> {
    try {
      const user = await this.env.incidentiq_db.prepare(
        "SELECT id FROM users WHERE id = ?"
      ).bind(userId).first<{ id: string }>();

      if (!user) {
        return jsonError("NOT_FOUND", "User not found", 404);
      }

      const prefs: any = {};
      if (body.confidence_threshold_override !== undefined) {
        const val = Number(body.confidence_threshold_override);
        if (isNaN(val) || val < 0 || val > 1) {
          return jsonError("VALIDATION_ERROR", "confidence_threshold_override must be a number between 0 and 1", 400);
        }
        prefs.confidence_threshold_override = val;
      }
      if (body.default_reviewer_name !== undefined) {
        if (typeof body.default_reviewer_name !== "string" || body.default_reviewer_name.trim().length === 0) {
          return jsonError("VALIDATION_ERROR", "default_reviewer_name must be a non-empty string", 400);
        }
        prefs.default_reviewer_name = body.default_reviewer_name;
      }

      await this.env.incidentiq_db.prepare(
        "UPDATE users SET preferences = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(JSON.stringify(prefs), userId).run();

      return json({ data: { userId, preferences: prefs } });
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleKnowledgeSeed(): Promise<Response> {
    try {
      const existing = await this.env.incidentiq_db.prepare(
        "SELECT COUNT(*) as count FROM knowledge_sources"
      ).first<{ count: number }>();

      if (existing && existing.count > 0) {
        return json({ data: { message: "Seed data already exists", existingCount: existing.count } });
      }

      const docs = getSeedDocuments();
      const results: Array<{ sourceId: string; chunkCount: number }> = [];

      for (const doc of docs) {
        const result = await ingestDocument(doc, this.env.incidentiq_db, this.env.AI);
        results.push(result);
      }

      return json({
        data: {
          message: "Seed data ingested",
          documents: docs.length,
          chunks: results.reduce((sum, r) => sum + r.chunkCount, 0),
          results,
        },
      }, 201);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleKnowledgeIngest(body: any): Promise<Response> {
    if (!body.title || !body.content || !body.type) {
      return jsonError("VALIDATION_ERROR", "title, type, and content are required", 400);
    }

    if (body.type !== "runbook" && body.type !== "past_incident") {
      return jsonError("VALIDATION_ERROR", "type must be 'runbook' or 'past_incident'", 400);
    }

    try {
      const result = await ingestDocument({
        title: body.title,
        type: body.type,
        content: body.content,
        tags: body.tags,
        source_id: body.source_id,
      }, this.env.incidentiq_db, this.env.AI);

      return json({ data: result }, 201);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleKnowledgeQuery(url: URL): Promise<Response> {
    const q = url.searchParams.get("q");
    if (!q || q.trim().length === 0) {
      return jsonError("VALIDATION_ERROR", "query parameter 'q' is required", 400);
    }

    const k = Math.min(Math.max(parseInt(url.searchParams.get("k") ?? "3", 10) || 3, 1), 20);

    try {
      const results = await retrieveRelevantKnowledge(q.trim(), this.env.incidentiq_db, this.env.AI, k);
      return json({ data: { query: q, k, results } });
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleKnowledgeDelete(sourceId: string): Promise<Response> {
    if (!sourceId) return jsonError("VALIDATION_ERROR", "sourceId is required", 400);

    try {
      const existing = await this.env.incidentiq_db.prepare(
        "SELECT COUNT(*) as count FROM knowledge_sources WHERE source_id = ? AND deleted_at IS NULL"
      ).bind(sourceId).first<{ count: number }>();

      if (!existing || existing.count === 0) {
        return jsonError("NOT_FOUND", "No active knowledge source found with this source_id", 404);
      }

      await deleteDocumentSource(sourceId, this.env.incidentiq_db);

      return json({ data: { message: "Source soft-deleted", sourceId, chunksAffected: existing.count } });
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleKnowledgeRestore(sourceId: string): Promise<Response> {
    try {
      await restoreDocumentSource(sourceId, this.env.incidentiq_db);
      return json({ data: { message: "Source restored", sourceId } });
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }
}

function isValidState(s: string): s is IncidentState {
  return ["Ingested", "TimelineDone", "Validated", "RootCauseDone", "PreventionDone", "AwaitReview", "Finalized"].includes(s);
}
