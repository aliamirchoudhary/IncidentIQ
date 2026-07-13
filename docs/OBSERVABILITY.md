# Observability

## Overview

Every Worker in the system emits structured JSON logs in the format specified in
[§2.2 of the quality/ops/security spec](04-quality-ops-security.md#22-structured-log-shape).

```json
{
  "incident_id": "<uuid>",
  "request_id": "<uuid>",
  "agent_name": "TimelineAgent | RootCauseAgent | PreventionAgent | ModeratorAgent | CoreApi | callLLM",
  "version": <number>,
  "event": "started | completed | failed",
  "status": "...",
  "detail": "...",
  "timestamp": "<ISO-8601>",
  "latency_ms": <number>,
  "provider": "gemini | openrouter | null",
  "route": "gateway | direct | null"
}
```

## Where to look

### Cloudflare Workers Logs Dashboard

Each Worker's real-time logs appear in the Cloudflare dashboard under
**Workers & Pages → `<worker-name>` → Logs**.

Filter by `incident_id` to reconstruct one incident's full story across all five
Workers.

### D1 `agent_activity_logs` Table

Persistent activity log written by core-api. Query with:

```sql
SELECT * FROM agent_activity_logs
WHERE incident_id = '<uuid>'
ORDER BY created_at ASC;
```

### Example: Find everything for one incident

1. Open the Cloudflare dashboard → Workers & Pages.
2. Open `core-api` → **Logs**.
3. In the filter bar, enter: `incident_id = "<your-incident-uuid>"`
4. All log lines from core-api for that incident appear — including the
   `started` and `completed` events around each agent RPC call with
   `latency_ms`.

To also see the agent Workers' internal logs (LLM call timing, deterministic
fallback, etc.), repeat the same filter for `timeline-agent`,
`rootcause-agent`, `prevention-agent`, and `moderator-agent`.

### Tracing a Single Request

Every user-facing API call (e.g. `POST /analyze`) generates a single
`request_id`. That same `request_id` is:

- Passed in the RPC payload to each agent Worker
- Written into every `logActivity` row for that chain step
- Included in every `console.log` JSON emitted by the agent Workers

To trace one request, filter any Worker's logs by `request_id = "<uuid>"`.

## AI Gateway Analytics

LLM calls routed through the Cloudflare AI Gateway (preferred route) appear
automatically in **AI → AI Gateway** in the dashboard. Token usage, request
counts, and latency per model are visible there without any extra work.

## Latency Tracking

Every agent RPC call in `runFullChain` is timed. The `latency_ms` field in
the `CoreApi` log lines shows the wall-clock time of each agent call. The
agent Workers also log their own internal latency (LLM call + parsing) in
their `completed` events.

To find a slow agent:

```sql
SELECT detail, status, round(julianday('now') - julianday(created_at), 0) AS days_ago
FROM agent_activity_logs
WHERE incident_id = '<uuid>'
ORDER BY created_at ASC;
```

Then cross-reference with the Workers Logs `latency_ms` field for specific
agent timings.
