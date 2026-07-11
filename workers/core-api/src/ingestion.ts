import { IncidentRoom } from "./incident-room";

interface Env {
  INCIDENT_ROOM: DurableObjectNamespace<IncidentRoom>;
  incidentiq_db: D1Database;
}

function makeId(): string {
  return crypto.randomUUID();
}

function makeRequestId(): string {
  return crypto.randomUUID();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function deriveIdempotencyKey(body: { timestamp?: string | null; detail: string; source?: string | null }): Promise<string> {
  return sha256Hex(`${body.timestamp ?? ""}|${body.detail}|${body.source ?? ""}`);
}

export async function logActivity(
  db: D1Database,
  incidentId: string,
  agentName: string,
  requestId: string,
  version: number,
  event: string,
  status?: string,
  detail?: string,
): Promise<void> {
  await db.prepare(
    "INSERT INTO agent_activity_logs (id, incident_id, agent_name, request_id, version, event, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(makeId(), incidentId, agentName, requestId, version, event, status ?? null, detail ?? null).run();
}

function getRoom(env: Env, id: string): DurableObjectStub<IncidentRoom> {
  const doId = env.INCIDENT_ROOM.idFromName(id);
  return env.INCIDENT_ROOM.get(doId);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(code: string, message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function createIncident(
  env: Env,
  db: D1Database,
  body: { title?: string; summary?: string },
  _authUser?: { id: string } | null,
): Promise<Response> {
  if (!body.title || typeof body.title !== "string" || body.title.trim().length === 0) {
    return errorResponse("VALIDATION_ERROR", "title is required and must be non-empty", 400);
  }
  if (!body.summary || typeof body.summary !== "string" || body.summary.trim().length === 0) {
    return errorResponse("VALIDATION_ERROR", "summary is required and must be non-empty", 400);
  }

  const id = makeId();
  const requestId = makeRequestId();
  const title = body.title.trim();
  const summary = body.summary.trim();
  const room = getRoom(env, id);
  const now = new Date().toISOString();

  try {
    await db.prepare(
      "INSERT INTO incidents (id, title, summary, status, created_at, updated_at) VALUES (?, ?, ?, 'Ingested', ?, ?)"
    ).bind(id, title, summary, now, now).run();

    await room.setIncident({ id, title, summary });
    const state = await room.getState() as any;
    await logActivity(db, id, "IngestionAgent", requestId, state.version, "completed", "incident_created", `Incident "${title}" created`);

    return jsonResponse({ id, title, summary, status: "Ingested", version: state.version, createdAt: now }, 201);
  } catch (err) {
    return errorResponse("INTERNAL", err instanceof Error ? err.message : "Failed to create incident", 500);
  }
}

export async function addEvent(
  env: Env,
  db: D1Database,
  incidentId: string,
  body: { timestamp?: string | null; detail?: string; source?: string; idempotency_key?: string },
  _authUser?: { id: string } | null,
): Promise<Response> {
  if (!body.detail || typeof body.detail !== "string" || body.detail.trim().length === 0) {
    return errorResponse("VALIDATION_ERROR", "detail is required and must be non-empty", 400);
  }

  const requestId = makeRequestId();
  const detail = body.detail.trim();
  const timestamp = body.timestamp ?? null;
  const source = body.source?.trim() ?? null;
  const idempotencyKey = body.idempotency_key || await deriveIdempotencyKey({ timestamp, detail, source: source ?? undefined });

  try {
    const incident = await db.prepare(
      "SELECT id FROM incidents WHERE id = ? AND deleted_at IS NULL"
    ).bind(incidentId).first();

    if (!incident) {
      return errorResponse("NOT_FOUND", "Incident not found", 404);
    }

    const existing = await db.prepare(
      "SELECT id, timestamp, detail, source, created_at FROM incident_events WHERE incident_id = ? AND idempotency_key = ?"
    ).bind(incidentId, idempotencyKey).first();

    if (existing) {
      return jsonResponse({
        id: existing.id,
        timestamp: existing.timestamp,
        detail: existing.detail,
        source: existing.source,
        createdAt: existing.created_at,
        duplicate: true,
      }, 200);
    }

    const room = getRoom(env, incidentId);
    const eventId = makeId();
    const now = new Date().toISOString();

    const doResult = await room.addEvent({ timestamp, detail, source: source ?? undefined }) as any;

    await db.prepare(
      "INSERT INTO incident_events (id, incident_id, timestamp, detail, source, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(eventId, incidentId, timestamp, detail, source, idempotencyKey, now).run();

    await logActivity(db, incidentId, "IngestionAgent", requestId, doResult.version, "completed", "event_added", `Event added: ${detail.slice(0, 100)}`);

    return jsonResponse({
      id: eventId,
      timestamp,
      detail,
      source,
      createdAt: now,
      duplicate: false,
    }, 201);
  } catch (err) {
    return errorResponse("INTERNAL", err instanceof Error ? err.message : "Failed to add event", 500);
  }
}

export async function getIncident(
  env: Env,
  db: D1Database,
  incidentId: string,
): Promise<Response> {
  try {
    const row = await db.prepare(
      "SELECT id, title, summary, status, created_at, updated_at FROM incidents WHERE id = ? AND deleted_at IS NULL"
    ).bind(incidentId).first<{ id: string; title: string; summary: string; status: string; created_at: string; updated_at: string }>();

    if (!row) {
      return errorResponse("NOT_FOUND", "Incident not found", 404);
    }

    const room = getRoom(env, incidentId);
    const state = await room.getState();

    const eventsRow = await db.prepare(
      "SELECT COUNT(*) as count FROM incident_events WHERE incident_id = ?"
    ).bind(incidentId).first<{ count: number }>();

    return jsonResponse({
      id: row.id,
      title: row.title,
      summary: row.summary,
      status: state.state,
      version: state.version,
      eventsCount: eventsRow?.count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    return errorResponse("INTERNAL", err instanceof Error ? err.message : "Failed to fetch incident", 500);
  }
}

export async function getReport(
  env: Env,
  db: D1Database,
  incidentId: string,
): Promise<Response> {
  try {
    const incident = await db.prepare(
      "SELECT id, title, summary, status, created_at, updated_at FROM incidents WHERE id = ? AND deleted_at IS NULL"
    ).bind(incidentId).first<{ id: string; title: string; summary: string; status: string; created_at: string; updated_at: string }>();

    if (!incident) {
      return errorResponse("NOT_FOUND", "Incident not found", 404);
    }

    const room = getRoom(env, incidentId);
    const state = await room.getState();

    const events = await db.prepare(
      "SELECT id, timestamp, detail, source, created_at FROM incident_events WHERE incident_id = ? ORDER BY created_at ASC"
    ).bind(incidentId).all();

    const timeline = await db.prepare(
      "SELECT id, time, event, confidence, note FROM timeline_entries WHERE incident_id = ? ORDER BY rowid ASC"
    ).bind(incidentId).all();

    const rootCause = await db.prepare(
      "SELECT id, cause, confidence, evidence, needs_review, provider_used FROM root_causes WHERE incident_id = ?"
    ).bind(incidentId).first();

    const recommendations = await db.prepare(
      "SELECT id, recommendation, reference FROM recommendations WHERE incident_id = ? ORDER BY rowid ASC"
    ).bind(incidentId).all();

    const reviews = await db.prepare(
      "SELECT id, reviewer_user_id, approved, modifications, target_state, created_at FROM reviews WHERE incident_id = ? ORDER BY created_at DESC"
    ).bind(incidentId).all();

    return jsonResponse({
      id: incident.id,
      title: incident.title,
      summary: incident.summary,
      status: state.state,
      version: state.version,
      createdAt: incident.created_at,
      updatedAt: incident.updated_at,
      events: events.results ?? [],
      timeline: timeline.results ?? [],
      rootCause: rootCause ?? null,
      recommendations: recommendations.results ?? [],
      reviews: reviews.results ?? [],
    });
  } catch (err) {
    return errorResponse("INTERNAL", err instanceof Error ? err.message : "Failed to fetch report", 500);
  }
}
