<p align="center">
  <img src="https://img.shields.io/badge/status-live-success?style=flat-square" alt="Status">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/D1-SQLite-3b82f6?style=flat-square" alt="D1">
  <img src="https://img.shields.io/badge/Durable_Objects-State_Machine-8b5cf6?style=flat-square" alt="Durable Objects">
  <img src="https://img.shields.io/badge/AI_Gateway-Gemini_→_OpenRouter-0288d1?style=flat-square" alt="AI Gateway">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License">
</p>

<h1 align="center">IncidentIQ</h1>
<p align="center"><strong>AI-Powered Incident Postmortem Automation on Cloudflare</strong></p>
<p align="center">Submit raw incident data once. Receive a structured, human-reviewed postmortem report — automatically.</p>

<div align="center">
  <table>
    <tr>
      <td align="center"><b>API</b></td>
      <td>https://core-api.aliamirchoudhary.workers.dev/api/v1</td>
    </tr>
    <tr>
      <td align="center"><b>Frontend</b></td>
      <td>https://incidentiq.pages.dev</td>
    </tr>
  </table>
</div>

---

## Table of Contents

- [Why IncidentIQ](#why-incidentiq)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Quick Demo](#quick-demo)
- [Deployment](#deployment)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why IncidentIQ

Postmortems are the single most effective tool for turning production outages into lasting reliability improvements — yet most teams struggle to write them consistently:

- **Too slow** — written hours or days after, when details are already fuzzy
- **Too inconsistent** — some deep and blameless, others shallow and finger-pointing
- **Too ephemeral** — buried in Slack, never turned into actionable runbook updates

**IncidentIQ fixes this.** Feed it the raw data (alerts, log snippets, engineer notes), and it orchestrates a pipeline of specialized AI agents to produce a structured draft report — with citations, confidence scores, and mandatory human approval before anything is finalized.

> **API-first architecture.** Every capability is exposed through a versioned REST API (`/api/v1`). The React frontend is a deliberately thin demo layer — all business logic lives server-side, enforced at the API level.

---

## How It Works

### The Agent Pipeline

A single `POST /api/v1/incidents/{id}/analyze` triggers five stages, each handled by an independent Cloudflare Worker:

| Stage | Worker | What It Does |
|---|---|---|
| 1 | **TimelineAgent** | Orders messy, possibly-untimestamped events into a clean chronology with per-event confidence scores |
| 2 | **Validation Gate** | Deterministically checks timeline quality (enough events? timestamp coverage > 50%? contradictions?) — runs inside core-api, no LLM cost |
| 3 | **RootCauseAgent** | Identifies root cause grounded in RAG knowledge (runbooks + past incidents). Optionally invokes an **LLM-decided external tool** to check live service status pages |
| 4 | **PreventionAgent** | Generates concrete preventive recommendations with citations to known procedures |
| 5 | **ModeratorAgent** | Assembles everything into a coherent draft report with a narrative summary |

**Every AI-generated finding is held for mandatory human review.** No code path reaches `Finalized` without a recorded human approval in the database. Engineers can approve, reject with modifications, or loop back individual stages for re-analysis.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| **Five separate Workers, not one monolith** | Each agent is independently deployable, scalable, and testable. `core-api` is orchestration + persistence only — it never calls an LLM itself |
| **Service Binding RPC, not HTTP** | Lower latency, no public surface for agent workers, built-in Cloudflare routing |
| **Durable Object per incident** | Strong consistency for state-machine transitions, natural concurrency serialization, crash recovery with no half-updated states |
| **LLM order: Gemini primary → OpenRouter fallback** | Gemini 2.5 Flash has a predictable 1M token/month free tier; OpenRouter's free-models pool is the resilient fallback |
| **Validation Gate is NOT a Worker** | It's deterministic (zero LLM calls) and reads in-memory data. A separate Worker would add RPC overhead for "a handful of `if` checks" |
| **RAG before reasoning** | `core-api` retrieves knowledge and passes it as RPC arguments. Agents never query D1 themselves — keeps RAG auditable and agents stateless |

---

## Architecture

### System Topology

```
                          ┌─────────────────────────────────────┐
                          │           core-api                   │
                          │  (orchestration + persistence)       │
    REST /api/v1 ───────▶ │                                     │
                          │  • D1 (11 tables)                    │
                          │  • Durable Object (IncidentRoom)    │
                          │  • RAG retrieval                     │
                          │  • Validation Gate (deterministic)  │
                          │  • Auth (bearer token)              │
                          └──────────┬──────────────────────────┘
                                     │ Service Binding RPC
                       ┌──────────────┼──────────────┬──────────────┐
                       ▼              ▼              ▼              ▼
               timeline-agent  rootcause-agent  prevention-agent  moderator-agent
               (stateless)     (stateless)      (stateless)       (stateless)
               LLM via         LLM via          LLM via           LLM via
               AI Gateway      AI Gateway +     AI Gateway        AI Gateway
                               StatusCorrelator
                               tool
```

### State Machine

```
Ingested ──(TimelineAgent)──▶ TimelineDone
TimelineDone ──(ValidationGate: valid)──▶ Validated
TimelineDone ──(ValidationGate: invalid)──▶ TimelineDone (self-loop)
Validated ──(RootCauseAgent)──▶ RootCauseDone
RootCauseDone ──(PreventionAgent)──▶ PreventionDone
PreventionDone ──(ModeratorAgent)──▶ AwaitReview
AwaitReview ──(human: approve)──▶ Finalized
AwaitReview ──(human: reject)──▶ TimelineDone / Validated / RootCauseDone
Finalized ──▶ (terminal)
```

### RAG Pipeline

| Component | Implementation |
|---|---|
| **Sources** | 5 curated runbooks + 2 past-incident write-ups (seeded). Finalized incidents auto-ingested for cross-incident memory |
| **Chunking** | Paragraph-level (150–400 words), with sentence-span overlap |
| **Embeddings** | Cloudflare Workers AI embedding model via AI Gateway |
| **Retrieval** | Cosine similarity, top-`k=3` (named constant), results passed as RPC arguments |
| **Graceful degradation** | Embedding failure → agents proceed with empty context, flag when reasoning without grounding |

### Human-in-the-Loop

- Every agent output is a **draft.** Nothing reaches `Finalized` without a `reviews` table row.
- **Approve:** Incident closes with `"Verified by {reviewer} on {date}"` recorded.
- **Reject:** Loops back to the targeted stage — add more data and re-trigger.
- **Concurrency:** Durable Object serialization guarantees exactly one approval succeeds — a second concurrent request is cleanly rejected.

### LLM Provider Strategy (3-Tier Fallback)

```
AI Gateway → Gemini  (route: "gateway")  ── preferred, all calls visible in dashboard
    ↓ (gateway unreachable)
Direct Gemini       (route: "direct")    ── logged distinctly, honestly countable
    ↓ (both fail)
OpenRouter          (route: "direct")    ── last resort
```

The `callLLM` utility makes one attempt per tier then returns a typed error. Whole-agent-call retry (3 attempts, exponential backoff) is `core-api`'s responsibility — keeping these layers separate prevents retry storms.

---

## API Reference

**Base path:** `/api/v1` &nbsp;•&nbsp; **Success:** `{ "data": <payload> }` &nbsp;•&nbsp; **Error:** `{ "error": { "code": string, "message": string } }`

### Incident Lifecycle

| Method | Endpoint | Auth | Idempotent |
|---|---|---|---|
| `POST` | `/incidents` | Bearer | Best-effort |
| `POST` | `/incidents/{id}/events` | Bearer | Yes (key) |
| `GET` | `/incidents?status=` | None | Read |
| `GET` | `/incidents/{id}` | None | Read |
| `GET` | `/incidents/{id}/report` | None | Read |
| `POST` | `/incidents/{id}/analyze` | Bearer | Safe to retry |
| `POST` | `/incidents/{id}/analyze-rootcause` | Bearer | No |
| `POST` | `/incidents/{id}/analyze-prevention` | Bearer | No |
| `POST` | `/incidents/{id}/analyze-moderate` | Bearer | No |
| `POST` | `/incidents/{id}/review` | Bearer | No |

### Knowledge / RAG

| Method | Endpoint | Auth |
|---|---|---|
| `POST` | `/knowledge/seed` | Bearer |
| `POST` | `/knowledge/ingest` | Bearer |
| `GET` | `/knowledge/query?q=&k=` | None |
| `DELETE` | `/knowledge/sources/{id}` | Bearer |
| `PATCH` | `/knowledge/sources/{id}/restore` | Bearer |

### Cross-Incident & Users

| Method | Endpoint | Auth |
|---|---|---|
| `GET` | `/incidents/similar?query=` | None |
| `GET` | `/users/{id}/preferences` | None |
| `PUT` | `/users/{id}/preferences` | Bearer |

### Auth

| Method | Endpoint | Auth |
|---|---|---|
| `POST` | `/auth/token` | Bootstrap key |

---

## Quick Demo

A complete incident lifecycle in **7 steps, ~30 seconds of pipeline time.**

```bash
API=https://core-api.aliamirchoudhary.workers.dev/api/v1
TOKEN=your-bearer-token
```

**1. Create an incident**
```bash
curl -s -X POST "$API/incidents" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"DB Pool Exhaustion","summary":"Payments service 503s at 14:30 UTC"}' | jq
```

**2. Add timeline events** (5 events, one with `null` timestamp to test the Validation Gate)
```bash
curl -s -X POST "$API/incidents/$ID/events" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timestamp":"2026-07-13T14:28:00Z","detail":"PagerDuty alert: error rate > 5%"}' | jq
# ... repeat for 4 more events
```

**3. Trigger analysis**
```bash
curl -s -X POST "$API/incidents/$ID/analyze" -H "Authorization: Bearer $TOKEN" | jq
# → 202 Accepted
```

**4. Watch the chain** in Cloudflare Workers Logs (filter by `incident_id`):
```
→ TimelineAgent event:completed  latency_ms:3421
→ ValidationGate event:completed status:"valid"
→ RootCauseAgent event:completed confidence:0.78  tool_invoked:StatusCorrelator
→ PreventionAgent event:completed recommendations:3
→ ModeratorAgent event:completed status:"AwaitReview" ✓
```

**5. Review the draft**
```bash
curl -s "$API/incidents/$ID/report" | jq '.data.status'
# → "AwaitReview"
```

**6. Approve**
```bash
curl -s -X POST "$API/incidents/$ID/review" -H "Authorization: Bearer $TOKEN" \
  -d '{"reviewer_user_id":"demo","approved":true}' | jq '.data.status'
# → "Finalized"
```

**7. View final report** — now includes `"Verified by demo on 2026-07-13T..."`.

The full chain completes in **20–40 seconds.** Every step is traceable across five Workers from the Cloudflare dashboard.

---

## Deployment

### Prerequisites

- Node.js LTS, pnpm 11+, Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account (free tier)
- Google Gemini API key (free) + OpenRouter API key (free)
- Cloudflare AI Gateway created (name: `incidentiq`)

### Local Development

```bash
pnpm install

# Set gitignored secrets per agent worker:
#   workers/timeline-agent/.dev.vars
#   GEMINI_API_KEY=...
#   OPENROUTER_API_KEY=...

# Run all five workers
wrangler dev \
  -c workers/timeline-agent/wrangler.jsonc \
  -c workers/rootcause-agent/wrangler.jsonc \
  -c workers/prevention-agent/wrangler.jsonc \
  -c workers/moderator-agent/wrangler.jsonc \
  -c workers/core-api/wrangler.jsonc \
  --port 8787

# Frontend (separate terminal)
cd client && pnpm dev  # :5173, proxies /api → :8787

# D1 migrations
cd workers/core-api && wrangler d1 migrations apply incidentiq-db --local
```

### Production Deployment

Deploy in order: agent workers first (Service Bindings require them), then core-api, then frontend.

```bash
# 1. Agent workers
cd workers/timeline-agent && wrangler deploy
cd ../rootcause-agent && wrangler deploy
cd ../prevention-agent && wrangler deploy
cd ../moderator-agent && wrangler deploy

# 2. core-api
cd ../core-api && wrangler deploy

# 3. Frontend (Cloudflare Pages)
cd ../../client && vite build && wrangler pages deploy dist --project-name incidentiq

# 4. Production migrations
cd ../workers/core-api && wrangler d1 migrations apply incidentiq-db --remote
```

### Environment Variables

| Variable | Used By | Required | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | All 4 agents | Yes | Primary LLM (Gemini 2.5 Flash) |
| `OPENROUTER_API_KEY` | All 4 agents | No | Fallback LLM |
| `AUTH_BOOTSTRAP_KEY` | core-api | No | Token generation |
| `ALLOWED_ORIGINS` | core-api | No | CORS allow-list |

Bindings (in `wrangler.jsonc`): `INCIDENT_ROOM` (DO), `TIMELINE_AGENT` / `ROOTCAUSE_AGENT` / `PREVENTION_AGENT` / `MODERATOR_AGENT` (Service Bindings), `incidentiq_db` (D1), `AI` (Workers AI).

---

## Cloudflare Services

| Service | Role |
|---|---|
| **Workers** | 5 independent serverless projects — one orchestrator + four agent workers |
| **Durable Objects** | Per-incident state machine with strong consistency and concurrency guarantees |
| **D1** | 11 tables: incidents, events, timelines, root causes, recommendations, reviews, conversations, knowledge corpus, users, sessions, audit logs |
| **Workers AI** | Embedding generation for RAG |
| **AI Gateway** | All LLM calls routed through here (Gemini → OpenRouter), with analytics |
| **Agents SDK** | Wired into all 4 agent workers; tool-calling for StatusCorrelator |
| **Service Bindings** | RPC calls from core-api to agents (no public HTTP for agent workers) |
| **Pages** | Static hosting for the React frontend |
| **Workers Observability** | Structured logs with `incident_id`, `request_id`, `agent_name`, `version` for cross-worker tracing |

---

## Testing

| Category | Coverage |
|---|---|
| **Unit** | Validation Gate logic, JSON extraction, state-machine transitions |
| **Integration** | CRUD operations, response envelope, full chain with validation halting |
| **Durable Object** | All legal transitions, illegal rejection, concurrent transition (exactly-one-wins) |
| **Auth** | Unauthenticated 401, authenticated success |
| **Golden Incident** | 3 scripted scenarios (database, deployment, network) with category-matching assertions |
| **Failure Injection** | Validation halts on bad input, chain recovery, state integrity on partial failure |
| **RAG Proof A** | Different queries → different, topically appropriate results |
| **RAG Proof B** | Deleting a document changes retrieval for a query that previously matched it |

```bash
cd tests && pnpm vitest run       # full suite
cd tests && pnpm vitest run --coverage
cd tests && pnpm vitest run tests/rag/
```

---

## Roadmap

> Everything below is **future/aspirational** — documented to show the design was made with an eye toward not painting the project into a corner. None of it is built.

- **API Monetization** — Per-account keys, usage-based pricing (the current auth model extends naturally)
- **SaaS Multi-Tenancy** — Organization isolation, row-level authorization
- **Enterprise Features** — RBAC, SSO (Cloudflare Access), audit export
- **Integrations** — Slack notifications, PagerDuty auto-create, GitHub/Jira issue linking, webhooks

### Known Limitations

- **Staleness detection:** No `last_reviewed_at` on runbooks (would flag old documents)
- **Load testing:** Correctness-verified; throughput not validated at scale
- **Rate limiting:** Not built (trivial via Cloudflare dashboard)
- **Token expiry:** Bearer tokens live 30 days; production would add refresh tokens

---

## Contributing

This is a challenge submission, not an active open-source project, but issues and PRs are welcome.

```bash
pnpm install && cd tests && pnpm vitest run
```

**Coding conventions** — typed interfaces, small functions, no TODOs in committed code, shared utilities in `/packages/shared`, consistent folder layout across all five workers.

---

## License

MIT — see [LICENSE](./LICENSE).
