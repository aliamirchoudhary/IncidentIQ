# IncidentIQ — D1 Schema Reference

## Migration file
`workers/core-api/migrations/0001_init_schema.sql` (the single authoritative source for the schema).

## Table list (11 tables)

| # | Table | Purpose | Key columns | Soft-delete? |
|---|---|---|---|---|
| 1 | `users` | Account + auth identity | id (PK), email (unique), name | No |
| 2 | `sessions` | Active login/API sessions | id (PK), user_id (FK→users), token (unique), expires_at | No |
| 3 | `incidents` | Core incident record + status | id (PK), title, summary, status, **deleted_at** | Yes |
| 4 | `incident_events` | Raw submitted events (write-once input) | id (PK), incident_id (FK→incidents), timestamp (nullable), detail, idempotency_key | No |
| 5 | `timeline_entries` | TimelineAgent's processed chronological output | id (PK), incident_id (FK→incidents), time, event, confidence | No |
| 6 | `root_causes` | Root-cause hypothesis per incident | id (PK), incident_id (FK→incidents, unique), cause, confidence, evidence, needs_review | No |
| 7 | `recommendations` | Preventive recommendations per incident | id (PK), incident_id (FK→incidents), recommendation, reference | No |
| 8 | `reviews` | Human review decisions | id (PK), incident_id (FK→incidents), reviewer_user_id (FK→users), approved, modifications, target_state | No |
| 9 | `conversations` | Human↔system exchange log | id (PK), incident_id (FK→incidents), author, message, message_type | No |
| 10 | `knowledge_sources` | RAG corpus (runbooks, past incidents, embeddings) | id (PK), title, type, content, tags, **embedding** (nullable), source_id, **deleted_at** | Yes |
| 11 | `agent_activity_logs` | Full audit trail | id (PK), incident_id (FK→incidents), agent_name, request_id, version, event, status, detail | No |

## Indexes

| Table | Index | Columns | Purpose |
|---|---|---|---|
| `sessions` | `idx_sessions_token` | token | Fast lookup by bearer token |
| `sessions` | `idx_sessions_user_id` | user_id | Find all sessions for a user |
| `incidents` | `idx_incidents_status` | status | Filter/list by lifecycle state |
| `incident_events` | `idx_incident_events_incident` | incident_id | All events for an incident |
| `incident_events` | `idx_incident_events_idempotency` | idempotency_key | Dedup check on event submission |
| `timeline_entries` | `idx_timeline_entries_incident` | incident_id | All timeline entries per incident |
| `recommendations` | `idx_recommendations_incident` | incident_id | All recommendations per incident |
| `reviews` | `idx_reviews_incident` | incident_id | All reviews per incident |
| `conversations` | `idx_conversations_incident` | incident_id | All messages per incident |
| `knowledge_sources` | `idx_knowledge_sources_type` | type | Filter by runbook vs past_incident |
| `knowledge_sources` | `idx_knowledge_sources_deleted` | deleted_at | Efficient soft-delete filtering |
| `agent_activity_logs` | `idx_agent_logs_incident_created` | incident_id, created_at | Fast audit-trail queries (this table grows fastest) |

## Mandatory challenge requirement → table mapping

| Requirement | Table(s) | How it's met |
|---|---|---|
| **Users** | `users` | Stores account identity (email, name). |
| **Sessions** | `sessions` | Stores active bearer tokens with expiry; token-based auth at the API layer. |
| **Conversations** | `conversations` | Logs every human↔system exchange per incident (author, message, message_type). Written by ingestion, validation gate, and review handler. |
| **Human reviews** | `reviews` | Records every approval/rejection with reviewer identity and optional modifications. No incident reaches `Finalized` without a row in this table (enforced by the DO state machine's allow-list). |
| **Knowledge sources** | `knowledge_sources` | Stores RAG corpus: runbooks (manually ingested) and past incidents (auto-ingested on finalization). Embeddings stored as JSON in `embedding` column; soft-delete via `deleted_at`. |
| **Agent activity logs** | `agent_activity_logs` | Full audit trail: every agent RPC call, validation gate check, and review action logged with `incident_id`, `request_id`, `version`, `agent_name`, `event`, `status`, and `detail`. Indexed on (incident_id, created_at) for fast retrieval. |
| **Soft-delete** | `incidents`, `knowledge_sources` | `deleted_at` nullable timestamp; normal queries filter `WHERE deleted_at IS NULL`. No hard deletes of auditable records. |
| **Separation of raw events vs processed timeline** | `incident_events` (raw), `timeline_entries` (processed) | Raw submitted events land in `incident_events` (write-once). TimelineAgent's ordered output lands in `timeline_entries` — they are never merged. |

## Notes

- All tables use TEXT UUIDs for primary keys (generated at the application layer, typically as `crypto.randomUUID()`).
- All timestamps are ISO 8601 TEXT per SQLite conventions.
- Foreign keys are enforced by D1 (SQLite FK support must be enabled per-connection via `PRAGMA foreign_keys = ON`).
- The `embedding` column on `knowledge_sources` is a JSON-serialized array of floats, populated in Stage 9 (RAG pipeline). It is nullable because it starts empty and is filled when documents are chunked and embedded.
- `root_causes` has a UNIQUE constraint on `incident_id` — each incident can have at most one active root cause (replaced on re-analysis).
