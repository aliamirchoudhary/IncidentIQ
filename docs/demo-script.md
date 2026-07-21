# IncidentIQ — Demo Script

This script walks through a complete incident lifecycle: create → add events → trigger analysis → watch the agent chain execute across five workers → review draft → approve → view final report.

---

## Setup

Assumptions:
- Production API at `https://core-api.aliamirchoudhary.workers.dev`
- You have a bearer token for authenticated requests (generate via `POST /api/v1/auth/token`)
- Cloudflare dashboard open to Workers & Pages → Logs for all five workers

```bash
API=https://core-api.aliamirchoudhary.workers.dev/api/v1
TOKEN=your-bearer-token
AUTH_HEADER="Authorization: Bearer $TOKEN"
```

---

## Step 1: Create an Incident

```bash
curl -s -X POST "$API/incidents" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "title": "Database Connection Pool Exhaustion — Production",
    "summary": "At approximately 14:30 UTC, the payments service started returning 503 errors. The on-call engineer observed connection timeouts to the primary PostgreSQL database. The incident lasted 23 minutes, resolved by restarting the connection pooler."
  }' | jq
```

**Expected output:**
```json
{
  "data": {
    "id": "abc-123-...",
    "title": "Database Connection Pool Exhaustion — Production",
    "status": "Ingested",
    "version": 1,
    "createdAt": "2026-07-13T..."
  }
}
```

Note the incident ID (`abc-123-...`) — you will need it for every subsequent step.

---

## Step 2: Add Timeline Events

```bash
INCIDENT=abc-123-...

curl -s -X POST "$API/incidents/$INCIDENT/events" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "timestamp": "2026-07-13T14:28:00Z",
    "detail": "PagerDuty alert: Payments service error rate > 5% (threshold 1%)"
  }' | jq

curl -s -X POST "$API/incidents/$INCIDENT/events" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "timestamp": "2026-07-13T14:30:00Z",
    "detail": "On-call engineer acknowledged alert, started investigating"
  }' | jq

curl -s -X POST "$API/incidents/$INCIDENT/events" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "timestamp": "2026-07-13T14:32:00Z",
    "detail": "Database connection pool at 100% utilization (max_connections=100)"
  }' | jq

curl -s -X POST "$API/incidents/$INCIDENT/events" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "timestamp": "2026-07-13T14:35:00Z",
    "detail": "Application logs: 'FATAL: remaining connection slots are reserved for non-replication superuser connections'"
  }' | jq

curl -s -X POST "$API/incidents/$INCIDENT/events" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "timestamp": null,
    "detail": "Connection pooler restarted at 14:48 UTC, errors began dropping immediately"
  }' | jq
```

**Expected:** Each event returns `201 Created` with the event details. Note the last event has `timestamp: null` — the Validation Gate will flag this as a minor issue but should still pass since 4 of 5 events have timestamps.

**Idempotency demo:** Submit the same event again:
```bash
curl -s -X POST "$API/incidents/$INCIDENT/events" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "timestamp": "2026-07-13T14:28:00Z",
    "detail": "PagerDuty alert: Payments service error rate > 5% (threshold 1%)"
  }' | jq
```
**Expected:** Returns `200 OK` with `"duplicate": true` — no duplicate event created.

---

## Step 3: Trigger the Full Analysis Pipeline

```bash
curl -s -X POST "$API/incidents/$INCIDENT/analyze" \
  -H "$AUTH_HEADER" | jq
```

**Expected:** Returns `202 Accepted` immediately (the chain runs asynchronously via `ctx.waitUntil`):
```json
{
  "data": {
    "incidentId": "abc-123-...",
    "status": "processing",
    "state": "Ingested"
  }
}
```

---

## Step 4: Watch the Chain Execute (Cloudflare Dashboard)

Open **Cloudflare Dashboard → Workers & Pages → Logs** for each worker as the chain runs.

### 4a. TimelineAgent (`timeline-agent` logs)

Filter by `incident_id = "<your-id>"`. Expect log lines like:
```
→ CoreApi event:started detail:"Calling TimelineAgent"
→ TimelineAgent event:started detail:"Generating timeline..."
→ TimelineAgent event:completed detail:"LLM call completed" latency_ms:3421
→ TimelineAgent event:completed detail:"Timeline generated with 5 entries"
→ CoreApi event:completed detail:"TimelineAgent completed with 5 entries"
```

The LLM (Gemini 2.5 Flash via AI Gateway) has ordered the events chronologically, assigned confidence scores to each, and added a note about the null-timestamp event being inferred.

**Narrative:** "AI suggested that the timeline started with the PagerDuty alert at 14:28, followed by the engineer acknowledging at 14:30. The null-timestamp event about the pooler restart was placed at the end based on context."

### 4b. Validation Gate (`core-api` logs, deterministic)

Immediately after TimelineAgent succeeds:
```
→ CoreApi event:started detail:"Running ValidationGate"
→ CoreApi event:completed status:"valid"
  detail:"5 timeline entries checked: 4 with explicit timestamps, 0 contradictory, no large gaps"
```

The Validation Gate has verified:
- Event count (5) >= minimum (2) ✓
- Timestamp coverage (80%) > threshold (50%) ✓
- No contradictory events with <1s separation ✓
- No unexplained large time gaps ✓

**Narrative:** "The Validation Gate confirmed the timeline is high-quality before expensive root-cause reasoning begins. This is a deterministic check — no LLM cost, just data integrity."

### 4c. Knowledge Retrieval (`core-api` logs)

```
→ CoreApi event:started detail:"Retrieving knowledge context..."
→ CoreApi event:completed detail:"Knowledge retrieval returned 3 chunks"
```

RAG retrieved the 3 most similar chunks from the knowledge base (runbooks on connection pool exhaustion, database failover, and a past incident).

### 4d. RootCauseAgent (`rootcause-agent` logs)

```
→ CoreApi event:started detail:"Calling RootCauseAgent"
→ RootCauseAgent event:started detail:"Analyzing root cause..."
→ StatusCorrelator event:started detail:"Model invoked StatusCorrelator tool"
→ StatusCorrelator event:completed detail:"GitHub status: operational, Cloudflare status: operational"
→ RootCauseAgent event:completed detail:"Root cause identified with 0.78 confidence"
→ CoreApi event:completed detail:"Root cause: Database connection pool exhaustion under load spike"
```

The LLM decided to invoke the StatusCorrelator tool to verify whether external providers (GitHub, Cloudflare) were operational — they were, ruling out a third-party cause.

**Narrative:** "AI suggested that the root cause is database connection pool exhaustion, with 78% confidence. The AI independently decided to check GitHub and Cloudflare status pages to rule out external dependencies. It cited a relevant runbook chunk as evidence."

### 4e. PreventionAgent (`prevention-agent` logs)

```
→ CoreApi event:started detail:"Calling PreventionAgent"
→ PreventionAgent event:completed detail:"3 recommendations generated"
→ CoreApi event:completed detail:"PreventionAgent completed with 3 recommendations"
```

**Narrative:** "AI suggested three preventive measures: increase connection pool max size, add pool-utilization alerting, and document the restart procedure in the runbook. Two of three are cited to knowledge base documents."

### 4f. ModeratorAgent (`moderator-agent` logs)

```
→ CoreApi event:started detail:"Calling ModeratorAgent"
→ ModeratorAgent event:completed detail:"Draft report assembled"
→ CoreApi event:completed detail:"Full analysis chain complete, incident in AwaitReview"
```

**Narrative:** "AI assembled a coherent draft report combining the timeline, root cause, and recommendations with a narrative summary paragraph."

---

## Step 5: View the Draft Report

```bash
curl -s "$API/incidents/$INCIDENT/report" | jq
```

**Expected output** (abbreviated):
```json
{
  "data": {
    "id": "abc-123-...",
    "title": "Database Connection Pool Exhaustion — Production",
    "status": "AwaitReview",
    "version": 6,
    "timeline": [
      {"time": "2026-07-13T14:28:00Z", "event": "PagerDuty alert: Payments service error rate > 5%", "confidence": 0.95 },
      {"time": "2026-07-13T14:30:00Z", "event": "On-call engineer acknowledged alert", "confidence": 0.92 },
      {"time": "2026-07-13T14:32:00Z", "event": "Database connection pool at 100% utilization", "confidence": 0.98 },
      {"time": "2026-07-13T14:35:00Z", "event": "Application logs: connection slots exhausted", "confidence": 0.97 },
      {"time": "2026-07-13T14:48:00Z", "event": "Connection pooler restarted, errors dropped", "confidence": 0.65,
       "note": "timestamp inferred from log ordering, not explicit" }
    ],
    "rootCause": {
      "cause": "Database connection pool exhaustion under load spike due to misconfigured max_connections",
      "confidence": 0.78,
      "evidence": "Matched connection-pool-exhaustion runbook (kb_003); StatusCorrelator confirmed no external provider outages"
    },
    "recommendations": [
      {"recommendation": "Increase connection pool max size from 20 to 50 and add pool-utilization alerting at 80%", "reference": "kb_003"},
      {"recommendation": "Document the connection pooler restart procedure in the runbook with a runbook-specific escalation path", "reference": null},
      {"recommendation": "Add PagerDuty integration to auto-create IncicidentIQ incidents from PagerDuty alerts", "reference": "kb_001"}
    ],
    "reportSummary": "On July 13, the payments service experienced a 23-minute outage caused by database connection pool exhaustion. The system identified the root cause as a misconfigured max_connections limit...",
    "needsReview": false
  }
}
```

---

## Step 6: Human Review — Approve

```bash
curl -s -X POST "$API/incidents/$INCIDENT/review" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "reviewer_user_id": "demo-reviewer",
    "approved": true
  }' | jq
```

**Expected:** Report is finalized. The API returns:
```json
{
  "data": {
    "status": "Finalized",
    "version": 7,
    "message": "Report approved by demo-reviewer on 2026-07-13T..."
  }
}
```

**Narrative:** "Human approved X — the engineer read the draft, agreed with the AI's analysis, and clicked Approve. The incident is now closed."

---

## Step 7: View the Final Report

```bash
curl -s "$API/incidents/$INCIDENT/report" | jq '.data.status'
```

**Expected:** `"Finalized"`

The full report now includes a "Verified by" reference. It is stored permanently in D1 and will be used as seed data for future RAG queries (cross-incident learning).

---

## Alternative: Reject Path

Want to show the HITL loop-back? Reject instead of approving in Step 6:

```bash
curl -s -X POST "$API/incidents/$INCIDENT/review" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{
    "reviewer_user_id": "demo-reviewer",
    "approved": false,
    "target_state": "RootCauseDone",
    "modifications": "The prevention recommendations should also include adding an RDS proxy layer"
  }' | jq
```

**Expected:** State loops back to `PreventionDone`. You can call `POST /analyze-moderate` to re-run just the moderator with the same data and get a revised report, or add more events and re-trigger from an earlier stage.

**Narrative:** "AI suggested three recommendations, but the human wanted a fourth — adding an RDS proxy layer. The human rejected the prevention stage with a note. After the correction, the pipeline can be re-run from that point."

---

## Total Run Time

Expect the full chain (5 events → timeline → validation → root cause → prevention → report) to complete in 20–40 seconds depending on LLM latency. The frontend polls `GET /report` every 3 seconds and updates automatically as each stage completes.
