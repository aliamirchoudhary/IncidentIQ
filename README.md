# IncidentIQ

**AI-powered incident postmortem automation, built on Cloudflare.**

IncidentIQ automates the tedious, inconsistent process of writing postmortems after production outages. Submit your incident timeline once; the system runs a chain of specialized AI agents (Timeline → Validation → RootCause → Prevention → Moderator) to produce a structured draft report. Every report must be **human-approved** before it is finalized — no AI decision goes live without a human in the loop.

> **API-first.** Everything the frontend does, the REST API does better. The React client is a thin demo layer; all business logic lives server-side.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Architecture](#2-architecture)
3. [API Reference](#3-api-reference)
4. [Deployment](#4-deployment)
5. [Cloudflare Services](#5-cloudflare-services)
6. [Testing](#6-testing)
7. [Roadmap](#7-roadmap)
8. [Walkthrough](#8-walkthrough)
9. [License](#9-license)
10. [Contributing](#10-contributing)
11. [Live Deployment](#11-live-deployment)

---

## 1. Product Overview

### Problem

Postmortems are critical for learning from outages, but they are often:
- Written hours or days after the fact, when details are already fuzzy.
- Inconsistent across teams — some deep and blameless, others shallow and finger-pointing.
- Buried in Slack threads and never turned into actionable runbook updates.

### Solution

IncidentIQ accepts raw incident data (alerts, log snippets, engineer notes) and runs it through a **pipeline of four LLM-powered agents plus one deterministic gate**, each responsible for exactly one analytical step:

1. **TimelineAgent** — Orders messy, possibly-untimestamped events into a clean chronology.
2. **Validation Gate** — Deterministically checks the timeline for quality (enough events? timestamps? contradictions?) before expensive reasoning begins.
3. **RootCauseAgent** — Identifies the most likely root cause, grounded in a RAG knowledge base of runbooks and past incidents, optionally checking external service status pages via an LLM-decided tool call.
4. **PreventionAgent** — Suggests concrete preventive measures with citations to known procedures.
5. **ModeratorAgent** — Assembles everything into a coherent draft report.

The pipeline is triggered by a single `POST /analyze` call. Every AI-generated finding is held for **mandatory human review** — no code path reaches `Finalized` without a recorded human approval in the database. Engineers can approve, reject with modifications, or send individual stages back for re-analysis.

### Key design decisions

| Decision | Rationale |
|---|---|
| **Five separate Workers, not one monolith** | Single responsibility. Each agent is independently deployable, scalable, and testable. core-api is orchestration + persistence only — it never calls an LLM itself. |
| **Service Binding RPC, not HTTP** | Lower latency, no public surface for agent workers, built-in Cloudflare routing. |
| **Durable Object per incident** | Strong consistency for state-machine transitions, natural concurrency serialization, crash recovery with no half-updated states. |
| **LLM order: Gemini primary, OpenRouter fallback** | Gemini 2.5 Flash has a predictable free tier with 1M tokens/month. OpenRouter's free-models pool serves as a resilient fallback, not the primary dependency. |
| **Validation Gate is NOT a Worker** | It's deterministic (zero LLM calls), synchronous, and reads in-memory data from core-api. Making it a separate Worker would add an RPC hop, serialization cost, and deployment surface for "a handful of `if` checks." |
| **RAG before reasoning, not during or after** | core-api retrieves knowledge and passes it as RPC arguments. Agents never query D1 themselves — this keeps RAG auditable and agents stateless. |

---

## 2. Architecture

```
                          ┌─────────────────────────────────────┐
                          │           core-api                    │
                          │  (orchestration + persistence)        │
    REST API ───────────▶ │                                     │
    /api/v1/*              │  - D1 (11 tables, all DB writes)     │
                          │  - Durable Object (IncidentRoom)     │
                          │  - RAG retrieval (embeddings, search)│
                          │  - Validation Gate (deterministic)    │
                          │  - Auth (bearer token)                │
                          └──────────┬──────────────────────────┘
                                     │ Service Binding RPC
                      ┌──────────────┼──────────────┬──────────────┐
                      ▼              ▼              ▼              ▼
              timeline-agent  rootcause-agent  prevention-agent  moderator-agent
              (stateless)     (stateless)      (stateless)       (stateless)
              LLM via         LLM via          LLM via           LLM via
              AI Gateway      AI Gateway +     AI Gateway        AI Gateway
                              StatusCorrelator
                              tool (Agents SDK)
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
AwaitReview ──(human: reject)──▶ TimelineDone / RootCauseDone / PreventionDone
Finalized ──▶ (terminal)
```

Five Workers, one Durable Object class, 11 D1 tables, four Service Bindings. All agent Workers are stateless — they hold zero state between invocations. State lives in the Durable Object (in-flight) and D1 (persistent).

### RAG Pipeline

- **Sources:** 5 curated runbooks + 2 past-incident write-ups (seeded), plus automatic ingestion of finalized incidents.
- **Chunking:** Paragraph-level (150–400 words), with sentence-span overlap.
- **Embeddings:** Cloudflare Workers AI embedding model, called through AI Gateway.
- **Retrieval:** Cosine similarity, top-k=3 (named constant), results passed to agents as RPC arguments.
- **Graceful degradation:** If embedding calls fail, agents proceed with empty context and flag when reasoning without grounding.

### Human-in-the-Loop

- Every agent output is a **draft**. Nothing reaches `Finalized` without a `reviews` table row.
- On approval: incident closes, "Verified by {reviewer} on {date}" is recorded.
- On rejection: incident loops back to the targeted stage (TimelineDone / RootCauseDone / PreventionDone), more data can be added, and analysis re-triggered.
- Concurrent approvals: Durable Object serialization guarantees exactly one succeeds.

---

## 3. API Reference

Base path: `/api/v1`. Response envelope:

- Success: `{ "data": <payload> }`
- Error: `{ "error": { "code": string, "message": string } }`

### Incident Lifecycle

| Method | Endpoint | Purpose | Auth | Idempotent |
|---|---|---|---|---|
| `POST` | `/incidents` | Create a new incident | Bearer | Best-effort |
| `POST` | `/incidents/{id}/events` | Add a raw timeline event | Bearer | Yes (idempotency key) |
| `GET` | `/incidents/{id}` | Fetch incident metadata | None | Read |
| `GET` | `/incidents/{id}/report` | Fetch current draft or final report | None | Read |
| `POST` | `/incidents/{id}/analyze` | Trigger full agent pipeline | Bearer | Safe to retry |
| `POST` | `/incidents/{id}/analyze-rootcause` | Trigger RootCauseAgent only | Bearer | No |
| `POST` | `/incidents/{id}/analyze-prevention` | Trigger PreventionAgent only | Bearer | No |
| `POST` | `/incidents/{id}/analyze-moderate` | Trigger ModeratorAgent only | Bearer | No |
| `POST` | `/incidents/{id}/review` | Approve/reject draft report | Bearer | No (one-shot) |

### Knowledge / RAG

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| `POST` | `/knowledge/seed` | Seed the knowledge base with default documents | Bearer |
| `POST` | `/knowledge/ingest` | Ingest a new document (auto-chunked + embedded) | Bearer |
| `GET` | `/knowledge/query?q=&k=` | Query the knowledge base (semantic search) | None |
| `DELETE` | `/knowledge/sources/{id}` | Soft-delete a knowledge source | Bearer |
| `PATCH` | `/knowledge/sources/{id}/restore` | Restore a soft-deleted source | Bearer |

### Cross-Incident & Users

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| `GET` | `/incidents/similar?query=` | Semantic search across finalized past incidents | None |
| `GET` | `/users/{id}/preferences` | Get user preferences (confidence threshold override) | None |
| `PUT` | `/users/{id}/preferences` | Update user preferences | Bearer |

### Auth

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| `POST` | `/auth/token` | Generate a bearer token (requires bootstrap key) | Bootstrap key |

---

## 4. Deployment

### Prerequisites

- Node.js LTS, pnpm 11+, Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account (free tier)
- Google Gemini API key (free tier) — primary LLM provider
- OpenRouter API key (free, fallback provider)
- Cloudflare AI Gateway created (named `incidentiq`)

### Local Development

```bash
# Install dependencies
pnpm install

# Set up local secrets (gitignored)
# Create workers/timeline-agent/.dev.vars
# GEMINI_API_KEY=...
# OPENROUTER_API_KEY=...
# Repeat for rootcause-agent, prevention-agent, moderator-agent
# core-api does NOT need .dev.vars (uses env bindings)

# Run all five workers concurrently
wrangler dev \
  -c workers/timeline-agent/wrangler.jsonc \
  -c workers/rootcause-agent/wrangler.jsonc \
  -c workers/prevention-agent/wrangler.jsonc \
  -c workers/moderator-agent/wrangler.jsonc \
  -c workers/core-api/wrangler.jsonc \
  --port 8787

# Or start each agent on dynamic ports first, then core-api:
wrangler dev -c workers/timeline-agent/wrangler.jsonc --port 0
wrangler dev -c workers/rootcause-agent/wrangler.jsonc --port 0
wrangler dev -c workers/prevention-agent/wrangler.jsonc --port 0
wrangler dev -c workers/moderator-agent/wrangler.jsonc --port 0
wrangler dev -c workers/core-api/wrangler.jsonc --port 8787

# Frontend (separate terminal)
cd client && pnpm dev  # runs on :5173, proxies /api to :8787

# Apply D1 migrations locally
cd workers/core-api
wrangler d1 migrations apply incidentiq-db --local
```

### Production Deployment

Deploy in order: agent workers first (core-api's Service Bindings need them to exist), then core-api, then frontend.

```bash
# 1. Deploy agent workers
cd workers/timeline-agent && wrangler deploy
cd ../rootcause-agent && wrangler deploy
cd ../prevention-agent && wrangler deploy
cd ../moderator-agent && wrangler deploy

# 2. Deploy core-api
cd ../core-api && wrangler deploy

# 3. Deploy frontend (Cloudflare Pages)
cd ../../
cd client && vite build && wrangler pages deploy dist --project-name incidentiq

# 4. Apply production D1 migrations
cd ../workers/core-api
wrangler d1 migrations apply incidentiq-db --remote
```

### Environment Variables & Secrets

| Variable | Used By | Required | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | All 4 agents | Yes | Primary LLM provider (Gemini 2.5 Flash) |
| `OPENROUTER_API_KEY` | All 4 agents | No | Fallback LLM provider (GPT-4o-mini via OpenRouter free pool) |
| `CLOUDFLARE_API_TOKEN` | All 4 agents | No | AI Gateway routing |
| `AUTH_BOOTSTRAP_KEY` | core-api | No | Token generation auth (unlocked if unset for dev) |
| `ALLOWED_ORIGINS` | core-api | No | CORS allow-list (has sensible defaults for local dev) |

Bindings (configured in `wrangler.jsonc`, not env vars): `INCIDENT_ROOM` (DO), `TIMELINE_AGENT` / `ROOTCAUSE_AGENT` / `PREVENTION_AGENT` / `MODERATOR_AGENT` (Service Bindings), `incidentiq_db` (D1), `AI` (Workers AI).

Set production secrets per-worker:
```bash
cd workers/timeline-agent
wrangler secret put GEMINI_API_KEY
wrangler secret put OPENROUTER_API_KEY
# Repeat for rootcause-agent, prevention-agent, moderator-agent

cd workers/core-api
wrangler secret put AUTH_BOOTSTRAP_KEY  # optional
```

---

## 5. Cloudflare Services

| Service | Where Used | Why | Files |
|---|---|---|---|
| **Cloudflare Workers** | All 5 projects | Serverless compute runtime. Each agent is an independent Worker with its own scope, env bindings, and deploy lifecycle. | `workers/*/src/index.ts` (all 5) |
| **Durable Objects** | core-api (`IncidentRoom`) | Per-incident state machine with strong consistency. Serializes concurrent requests (no race conditions), persists across evictions. Only DO guarantee enables the "exactly one approval wins" concurrency proof. | `workers/core-api/src/incident-room.ts` |
| **D1 (SQLite at the edge)** | core-api | 11 tables for all persistent data: incidents, events, timelines, root causes, recommendations, reviews, conversations, knowledge corpus, users, sessions, audit logs. | `workers/core-api/src/ingestion.ts`, `workers/core-api/migrations/0001_init_schema.sql` |
| **Workers AI** | core-api | Embedding generation for RAG chunk storage (via AI binding). | `workers/core-api/src/rag/embed.ts` |
| **AI Gateway** | All 4 agents (via `callLLM`) | All LLM requests pass through AI Gateway with provider routing (Gemini → OpenRouter fallback), analytics, and logging. Custom gateway name: `incidentiq`. | `packages/shared/src/llm/callLLM.ts` |
| **Agents SDK** | All 4 agent Workers | SDK-wired Agent classes with typed RPC methods. RootCauseAgent uses the SDK's tool-calling mechanism for StatusCorrelator. | `workers/*/src/index.ts` |
| **Service Bindings** | core-api → 4 agents | RPC calls from core-api to agent workers (no public HTTP surface for agents). | `workers/core-api/wrangler.jsonc` |
| **Cloudflare Pages** | Frontend | Hosts the React client as a static site with SPA redirect. | `client/public/_redirects`, `.github/workflows/deploy.yml` |
| **Workers Observability** | All 5 projects | Structured JSON logs visible in Cloudflare dashboard. Every log line carries `incident_id`, `request_id`, `agent_name`, `version` for cross-worker tracing. | All worker `src/index.ts` files, `docs/OBSERVABILITY.md` |

### LLM Provider Strategy (3-tier fallback)

1. **AI Gateway → Gemini** (`route: "gateway"`, provider: `"gemini"`) — preferred path, all calls visible in AI Gateway dashboard.
2. **Direct Gemini** (`route: "direct"`, provider: `"gemini"`) — fallback when AI Gateway itself is unreachable (not just provider failure through the gateway). Every such call is logged distinctly so it's honestly countable.
3. **OpenRouter** (`route: "direct"`, provider: `"openrouter"`) — last-resort fallback when both gateway and direct Gemini fail.

The `callLLM` utility in `packages/shared` makes one attempt at each tier, then returns a typed error. Whole-agent-call retry (3 attempts with exponential backoff) is core-api's responsibility — these two retry layers are kept separate to prevent cascading retry storms.

---

## 6. Testing

The test suite follows the taxonomy defined in `04-quality-ops-security.md` §1:

| Category | Coverage | Files |
|---|---|---|
| **Unit** | Validation Gate logic, JSON extraction utility, state-machine transition allow-list | `tests/unit/validation.test.ts`, `tests/unit/utils.test.ts`, `tests/unit/state-transitions.test.ts` |
| **Integration** | CRUD operations, response envelope, full chain with validation halting | `tests/integration/api.test.ts`, `tests/integration/chain.test.ts` |
| **Durable Object** | All legal transitions, illegal rejection, concurrent transition (exactly-one-wins) | `tests/do/state-machine.test.ts`, `tests/do/concurrency.test.ts` |
| **Auth** | Unauthenticated 401, authenticated success | `tests/auth/security.test.ts` |
| **Golden Incident** | 3 scripted incidents (database, deployment, network) with category-matching assertions | `tests/golden/incidents.test.ts` |
| **Failure Injection** | Validation halts on bad input, chain recovery after retry, state integrity on partial failure | `tests/failure/injection.test.ts` |
| **RAG Proof A** | Two different queries return different, topically appropriate results | `tests/rag/proof.test.ts` |
| **RAG Proof B** | Deleting a document changes retrieval results for a query that used to match it | `tests/rag/proof.test.ts` |
| **Regression** | Grows organically when real bugs are found and fixed | (intentional, not pre-seeded) |
| **Load testing** | **Explicitly out of scope** for this challenge submission. The DO-per-incident model should scale in principle (each incident is an independent DO instance), but correctness — not throughput — was the testing focus. | Documented gap in `04-quality-ops-security.md` §1 and README. |
| **Manual** | Per-stage checks in `03-manual-setup-steps.md` (human judgment calls like "does this output read as sensible") | (human-run, not automated) |

```bash
# Run the full test suite
cd tests && pnpm vitest run

# Run with coverage
cd tests && pnpm vitest run --coverage

# Run a specific category
cd tests && pnpm vitest run tests/unit/
cd tests && pnpm vitest run tests/rag/
```

---

## 7. Roadmap

> Everything below is **future/aspirational** — documented to show the design was made with an eye toward not painting the project into a corner. None of it is built. See `05-product-vision-roadmap.md` for the full discussion.

### Phase 2: API Monetization
- Public API documentation site, generated from the existing API reference.
- Per-account API keys with usage-based or tiered pricing.
- The current bearer-token auth model is already structured to extend naturally into this.

### Phase 3: SaaS Multi-Tenancy
- The `users` table would need an `organization_id` column for proper isolation — the current schema does not have this and would need a real migration.
- DO naming (`idFromName(incident_id)`) would need organization-scoping to prevent cross-tenant ID collisions.
- Row-level authorization (currently binary authenticated/not — would need role checks).

### Phase 4: Enterprise Features
- Role-based access control (admin / reviewer / read-only).
- SSO via Cloudflare Access integration.
- Audit export (the `agent_activity_logs` and `reviews` tables already contain the right data — it's a reporting feature, not a new data model).

### Phase 5: Integrations
- **Slack** — notification + approve/reject action when a report reaches `AwaitReview`.
- **PagerDuty** — auto-create postmortem when a PagerDuty incident resolves.
- **GitHub** — link finalized postmortems to fixing PRs/commits, auto-open tracking issues for recommendations.
- **Jira** — same pattern for Jira-based teams.
- **Webhooks** — generic outbound webhooks on key events (`incident.finalized`, `incident.needs_review`).

### Known Limitations (not blocking)
- **Staleness detection for runbooks:** A production version would want a `last_reviewed_at` field on `knowledge_sources` to flag documents that haven't been reviewed in N months. Not built — documented.
- **Load testing:** Not validated against real concurrent incident volume — see §6.
- **Rate limiting:** Not built (would matter more once API is genuinely public).
- **Replay attack mitigation beyond idempotency:** Bearer tokens don't expire mid-session. Production would want short-lived tokens with refresh.

---

## 8. Walkthrough

A complete incident lifecycle in 7 steps:

1. **Create an incident** — `POST /api/v1/incidents` with title + summary. Returns an incident ID with status `Ingested`.
2. **Add events** — `POST /api/v1/incidents/{id}/events` with timestamp + detail. Each event is dual-written to D1 (`incident_events`) and the DO working state. Idempotency keys prevent duplicates on retry.
3. **Trigger analysis** — `POST /api/v1/incidents/{id}/analyze`. Returns `202 Accepted` immediately. The chain runs asynchronously:
   - **TimelineAgent** orders events chronologically with confidence scores.
   - **Validation Gate** (deterministic) checks quality: event count ≥ 2, timestamp coverage > 50%, no contradictions, no large unexplained gaps. On failure: stays in `TimelineDone`, issues written to conversations, more events can be added.
   - **RootCauseAgent** retrieves top-3 knowledge chunks via RAG, optionally invokes StatusCorrelator tool (LLM decides), returns cited root cause with confidence.
   - **PreventionAgent** retrieves context via RAG, returns cited recommendations.
   - **ModeratorAgent** assembles draft report with optional narrative summary.
4. **Poll for progress** — `GET /api/v1/incidents/{id}/report` reflects real incremental state mid-chain. Each agent's completion advances the DO state machine.
5. **Review the draft** — Once status reaches `AwaitReview`, the full report is available: ordered timeline, root cause with evidence, recommendations with references, `needsReview` flag.
6. **Approve or reject** — `POST /api/v1/incidents/{id}/review` with `{ approved: true/false, reviewer_user_id, modifications?, target_state? }`. Approval advances to `Finalized`. Rejection loops back to `TimelineDone` / `RootCauseDone` / `PreventionDone`.
7. **View final report** — The finalized report includes a "Verified by {reviewer} on {date}" stamp. It is stored permanently in D1 and auto-ingested into the RAG corpus for future cross-incident queries.

The full chain (5 events → final report) completes in 20–40 seconds depending on LLM latency. Every step is visible in Cloudflare Workers Logs filtered by `incident_id`.

---

## 9. License

MIT License — see [LICENSE](./LICENSE).

---

## 10. Contributing

This is a challenge submission, not an active open-source project, so the contribution surface is intentionally small.

### Running Tests

```bash
pnpm install
cd tests && pnpm vitest run
```

### Coding Conventions

- **Typed interfaces.** Every RPC input/output shape is a named TypeScript interface matching its contract in `00-architecture-and-contracts.md` §3.
- **Consistent folder structure.** All five workers mirror the same layout (`src/`, `wrangler.jsonc`, `tsconfig.json`).
- **Small functions.** Parse → validate → call → persist → log: each is a separate concern, not a single block.
- **No TODOs in committed code.** Deferred work goes in the README roadmap, not a comment.
- **No dead code.** Debug routes from early stages are removed or gated behind dev-only flags before final deployment.
- **No duplicated logic.** Shared utilities (like `callLLM`) live in `/packages/shared`.
- **Meaningful commits.** The per-stage commit messages in `02-stage-prompts.md` are the minimum; notable divergences from the plan go in the commit body.

### PR Process

1. Open an issue describing the change.
2. Fork, implement against the conventions above.
3. Ensure all tests pass (`cd tests && pnpm vitest run`).
4. Open a PR with a clear description of what changed and why.

---

## 11. Live Deployment

| Component | URL |
|---|---|
| **core-api** | `https://core-api.aliamirchoudhary.workers.dev` |
| **Frontend** | `https://incidentiq.pages.dev` |

> The frontend proxies `/api` to core-api's production URL. All examples in this README use `POST /api/v1/incidents` — prefix with the core-api URL when using curl directly.
