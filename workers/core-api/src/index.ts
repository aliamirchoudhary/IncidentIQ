import { WorkerEntrypoint } from "cloudflare:workers";
import { IncidentRoom, type IncidentState } from "./incident-room";
import { createIncident, addEvent, getIncident, getReport, logActivity } from "./ingestion";
import { validateTimeline } from "./validation";
import { ingestDocument, deleteDocumentSource, restoreDocumentSource, retrieveRelevantKnowledge, getSeedDocuments } from "./rag";

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

interface RootCauseInput {
  incident_id: string;
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

    const rootcauseMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/analyze-rootcause$/);
    if (rootcauseMatch) {
      return addCors(await this.handleRootCause(rootcauseMatch[1]), origin);
    }

    const preventionMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/analyze-prevention$/);
    if (preventionMatch) {
      return addCors(await this.handlePrevention(preventionMatch[1]), origin);
    }

    const moderateMatch = method === "POST" && path.match(/^\/api\/v1\/incidents\/([^/]+)\/analyze-moderate$/);
    if (moderateMatch) {
      return addCors(await this.handleModerate(moderateMatch[1]), origin);
    }

    // KNOWLEDGE / RAG ROUTES

    if (method === "POST" && path === "/api/v1/knowledge/seed") {
      return addCors(await this.handleKnowledgeSeed(), origin);
    }

    if (method === "POST" && path === "/api/v1/knowledge/ingest") {
      const body = await request.json().catch(() => ({})) as any;
      return addCors(await this.handleKnowledgeIngest(body), origin);
    }

    if (method === "GET" && path === "/api/v1/knowledge/query") {
      return addCors(await this.handleKnowledgeQuery(url), origin);
    }

    const deleteMatch = method === "DELETE" && path.match(/^\/api\/v1\/knowledge\/sources\/([^/]+)$/);
    if (deleteMatch) {
      return addCors(await this.handleKnowledgeDelete(deleteMatch[1]), origin);
    }

    const restoreMatch = method === "PATCH" && path.match(/^\/api\/v1\/knowledge\/sources\/([^/]+)\/restore$/);
    if (restoreMatch) {
      return addCors(await this.handleKnowledgeRestore(restoreMatch[1]), origin);
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
        "SELECT id FROM incidents WHERE id = ? AND deleted_at IS NULL"
      ).bind(incidentId).first<{ id: string }>();
      if (!incident) {
        return jsonError("NOT_FOUND", "Incident not found", 404);
      }

      const state: any = await room.getState();
      if (state.state !== "Ingested" && state.state !== "TimelineDone") {
        return jsonError("CONFLICT", "Incident is in state \"" + state.state + "\", expected \"Ingested\" or \"TimelineDone\"", 409);
      }

      const isRetrigger = state.state === "TimelineDone";

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

      if (isRetrigger) {
        await this.env.incidentiq_db.prepare(
          "DELETE FROM timeline_entries WHERE incident_id = ?"
        ).bind(incidentId).run();
      }

      const now = new Date().toISOString();
      for (const entry of result.timeline) {
        await this.env.incidentiq_db.prepare(
          "INSERT INTO timeline_entries (id, incident_id, time, event, confidence, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), incidentId, entry.time, entry.event, entry.confidence, entry.note ?? null, now).run();
      }

      await (room as any).setAgentResult("timeline", result.timeline);

      let currentVersion = state.version;

      if (!isRetrigger) {
        const transitionResult: any = await room.transition("TimelineDone" as IncidentState);
        if (!transitionResult.success) {
          return jsonError("INTERNAL", transitionResult.error ?? "State transition failed", 500);
        }
        currentVersion = transitionResult.version;
      }

      await logActivity(
        this.env.incidentiq_db, incidentId, "TimelineAgent", crypto.randomUUID(),
        currentVersion, "completed", "success",
        "Timeline generated with " + result.timeline.length + " entries",
      );

      const validation = validateTimeline(result.timeline, rawEvents);

      if (!validation.valid) {
        await (room as any).setValidationStatus(validation.issues);

        const issuesSummary = validation.issues.map(i => "- " + i.detail).join("\n");
        await this.env.incidentiq_db.prepare(
          "INSERT INTO conversations (id, incident_id, author, message, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), incidentId, "agent", issuesSummary, "validation", now).run();

        await logActivity(
          this.env.incidentiq_db, incidentId, "ValidationGate", crypto.randomUUID(),
          currentVersion, "completed", "invalid",
          "Validation failed: " + validation.issues.map(i => i.type + ": " + i.detail).join("; "),
        );

        return json({
          data: {
            incidentId,
            status: "validation_failed",
            state: "TimelineDone",
            version: currentVersion,
            timeline: result.timeline,
            validation,
          },
        }, 200);
      }

      const transitionResult: any = await room.transition("Validated" as IncidentState);
      if (!transitionResult.success) {
        return jsonError("INTERNAL", transitionResult.error ?? "State transition to Validated failed", 500);
      }

      await (room as any).setValidationStatus(null);

      await logActivity(
        this.env.incidentiq_db, incidentId, "ValidationGate", crypto.randomUUID(),
        transitionResult.version, "completed", "valid",
        "Validation passed: " + result.timeline.length + " timeline entries checked",
      );

      return json({
        data: {
          incidentId,
          status: "success",
          state: "Validated",
          version: transitionResult.version,
          timeline: result.timeline,
          validation,
          provider: result.provider_used ?? null,
          route: result.route_used ?? null,
        },
      }, 200);
    } catch (err) {
      return jsonError("INTERNAL", err instanceof Error ? err.message : String(err), 500);
    }
  }

  private async handleRootCause(incidentId: string): Promise<Response> {
    try {
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
          this.env.incidentiq_db, incidentId, "KnowledgeRetrieval", crypto.randomUUID(),
          state.version, "completed", "degraded",
          "Knowledge retrieval failed, proceeding with empty context: " + (err instanceof Error ? err.message : String(err)),
        );
      }

      const stub = getAgentStub(this.env.ROOTCAUSE_AGENT) as unknown as RootCauseAgentRPC;
      const result: RootCauseOutput = await stub.analyzeRootCause({
        incident_id: incidentId,
        timeline,
        retrieved_context,
      });

      if (result.status !== "success" || !result.cause) {
        await logActivity(
          this.env.incidentiq_db, incidentId, "RootCauseAgent", crypto.randomUUID(),
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
        this.env.incidentiq_db, incidentId, "RootCauseAgent", crypto.randomUUID(),
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
          this.env.incidentiq_db, incidentId, "KnowledgeRetrieval", crypto.randomUUID(),
          state.version, "completed", "degraded",
          "Knowledge retrieval failed, proceeding with empty context: " + (err instanceof Error ? err.message : String(err)),
        );
      }

      const stub = getAgentStub(this.env.PREVENTION_AGENT) as unknown as PreventionAgentRPC;
      const result: PreventionOutput = await stub.generatePrevention({
        incident_id: incidentId,
        root_cause: rootCauseRow.cause,
        root_cause_evidence: rootCauseRow.evidence ?? "",
        retrieved_context,
      });

      if (result.status !== "success" || !result.recommendations || result.recommendations.length === 0) {
        await logActivity(
          this.env.incidentiq_db, incidentId, "PreventionAgent", crypto.randomUUID(),
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
        this.env.incidentiq_db, incidentId, "PreventionAgent", crypto.randomUUID(),
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
          this.env.incidentiq_db, incidentId, "ModeratorAgent", crypto.randomUUID(),
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
        this.env.incidentiq_db, incidentId, "ModeratorAgent", crypto.randomUUID(),
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
