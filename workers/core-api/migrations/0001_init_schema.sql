-- Migration number: 0001 	 2026-07-11T10:05:26.360Z
-- Initial schema: all 11 tables for IncidentIQ core-api.
-- Soft-delete via deleted_at on incidents and knowledge_sources per §5.1.

-- 1. users — Account + auth identity
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. sessions — Active login/API sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- 3. incidents — Core incident record + status (soft-delete via deleted_at)
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Ingested',
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

-- 4. incident_events — Raw submitted events (write-once input, before processing)
CREATE TABLE IF NOT EXISTS incident_events (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  timestamp TEXT,
  detail TEXT NOT NULL,
  source TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_events_idempotency ON incident_events(idempotency_key);

-- 5. timeline_entries — TimelineAgent's processed, chronologically-ordered output
CREATE TABLE IF NOT EXISTS timeline_entries (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  time TEXT NOT NULL,
  event TEXT NOT NULL,
  confidence REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timeline_entries_incident ON timeline_entries(incident_id);

-- 6. root_causes — Root-cause hypothesis per incident
CREATE TABLE IF NOT EXISTS root_causes (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL UNIQUE REFERENCES incidents(id),
  cause TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  provider_used TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. recommendations — Preventive recommendations per incident
CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  recommendation TEXT NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recommendations_incident ON recommendations(incident_id);

-- 8. reviews — Human review decisions (audit/accountability record)
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  reviewer_user_id TEXT NOT NULL REFERENCES users(id),
  approved INTEGER NOT NULL,
  modifications TEXT,
  target_state TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_incident ON reviews(incident_id);

-- 9. conversations — Human↔system exchange log per incident
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  message_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_incident ON conversations(incident_id);

-- 10. knowledge_sources — RAG corpus with embeddings (soft-delete via deleted_at)
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  embedding TEXT,
  source_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_type ON knowledge_sources(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_deleted ON knowledge_sources(deleted_at);

-- 11. agent_activity_logs — Full audit trail (grows fastest — index from day one)
CREATE TABLE IF NOT EXISTS agent_activity_logs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  agent_name TEXT NOT NULL,
  request_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  event TEXT NOT NULL,
  status TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_incident_created ON agent_activity_logs(incident_id, created_at);
