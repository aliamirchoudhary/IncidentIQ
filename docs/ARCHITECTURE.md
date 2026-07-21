# IncidentIQ — Architecture Lock-In (Stage 0)



## 1. Architecture Summary

IncidentIQ is a Cloudflare-native, multi-agent incident postmortem platform.
A single **core-api Worker** owns the public REST API (at `/api/v1`), all D1
tables, the Durable Object that tracks each incident's lifecycle state, and
the deterministic Validation Gate. When an engineer submits events, core-api
calls four separate **stateless agent Workers** (TimelineAgent,
RootCauseAgent, PreventionAgent, ModeratorAgent) via Service Binding RPC —
never HTTP. Each agent is a pure function: it receives structured input,
optionally calls an LLM through one of four independent providers:
Cloudflare Workers AI (primary), OpenRouter (secondary fallback),
Cloudflare AI Gateway (tertiary), or Direct Gemini (last resort).
Each provider has its own free quota, and the chain is tried in order.
Agents return structured output. core-api never calls an
LLM itself; its job is strictly orchestration + persistence.

Agents have no knowledge of each other or direct access to D1 or the
Durable Object. A deterministic Validation Gate (inside core-api, not a
Worker) sits between TimelineAgent and RootCauseAgent, catching bad timelines
before expensive reasoning begins. Human-in-the-loop review is structurally
enforced: no code path reaches `Finalized` without a recorded human decision
in the `reviews` table.

The React frontend (built last, Stage 16) is a deliberately thin demo client
with zero business logic — every rule is enforced in core-api's REST API.

---

## 2. Component List

### Workers (5 separately deployable Cloudflare Workers)

| Worker | Responsibility | Public endpoint? | Has DO? | Has D1? | Calls LLM? |
|---|---|---|---|---|---|
| **core-api** | Public REST API, D1 persistence, Durable Object (IncidentRoom), RAG retrieval, Validation Gate, authentication | Yes | Yes (IncidentRoom) | Yes (all tables) | No (delegates to agents) |
| **timeline-agent** | Convert raw events into structured chronological timeline | No | No | No | Yes |
| **rootcause-agent** | Produce cited root-cause hypothesis with confidence score | No | No | No | Yes (may also invoke StatusCorrelator tool via Agents SDK) |
| **prevention-agent** | Produce preventive recommendations grounded in root cause | No | No | No | Yes |
| **moderator-agent** | Assemble all prior agent outputs into a coherent draft report | No | No | No | Yes (optional narrative summary only) |

### Durable Object

| Class | Worker | Purpose |
|---|---|---|
| **IncidentRoom** | core-api | Tracks per-incident state machine via explicit allow-list (see §4.1 of architecture doc). Single source of truth for lifecycle position. Serializes requests (DO guarantee resolves races). Has a `version` integer incremented on every transition for observability. |

### D1 Tables (all in core-api)

| Table | Key rows | Written by | Read by |
|---|---|---|---|
| `users` | Account + auth identity | core-api (signup) | core-api (auth) |
| `sessions` | Active login tokens | core-api (login) | core-api (auth) |
| `incidents` | Core incident record + status | core-api | core-api, frontend |
| `incident_events` | Raw submitted events (write-once input, before any processing) | core-api (on `/events`) | core-api (passed to TimelineAgent) |
| `timeline_entries` | TimelineAgent's processed, chronologically-ordered output | core-api (after TimelineAgent) | core-api |
| `root_causes` | Per-incident root cause | core-api (after RootCauseAgent) | core-api |
| `recommendations` | Per-incident recommendations | core-api (after PreventionAgent) | core-api |
| `reviews` | Human review decisions | core-api (on `/review`) | core-api, frontend |
| `conversations` | Human↔system exchange log | core-api (ingestion, validation, review) | core-api, frontend |
| `knowledge_sources` | RAG corpus (runbooks, past incidents, embeddings) | core-api (ingestion + auto-ingest on finalization) | core-api (retrieval) |
| `agent_activity_logs` | Full audit trail | core-api (after every agent RPC + review) | core-api, dashboards |

### Service Bindings (core-api → agent workers)

| Binding | Direction | Protocol |
|---|---|---|
| `TimelineAgent` | core-api → timeline-agent | RPC via WorkerEntrypoint |
| `RootCauseAgent` | core-api → rootcause-agent | RPC via WorkerEntrypoint |
| `PreventionAgent` | core-api → prevention-agent | RPC via WorkerEntrypoint |
| `ModeratorAgent` | core-api → moderator-agent | RPC via WorkerEntrypoint |

All use RPC (not HTTP fetch). core-api passes a `request_id` through every
RPC call for cross-worker tracing. Agents never call each other.

### Validation Gate (NOT a Worker — lives inside core-api)

**Why it's not a Worker** (per §3.2): it's deterministic (zero LLM calls),
has no isolation needs, and needs to read the timeline array that core-api
just received from TimelineAgent in-memory. Making it a separate Worker would
add an extra RPC hop, another Worker to deploy/secure/monitor, and
serialization/deserialization overhead — none justified for "a handful of
`if` checks." Its checks are:

- Event count below a minimum threshold (default 2)
- More than N% of events missing timestamps
- Contradictory events with no time separation to explain the conflict
- Suspiciously large unexplained time gap between incident start and first event

On failure: incident stays in `TimelineDone` (self-loop), validation issues
are written to `conversations` and `agent_activity_logs`, and more events can
still be added via `POST /incidents/{id}/events`. On success: core-api
advances to `Validated` and proceeds to RootCauseAgent.

---

## 3. Agent Responsibilities

**TimelineAgent** (`timeline-agent` Worker): Converts raw, possibly-unordered
events into a chronologically ordered timeline with per-event confidence
scores and gap/anomaly annotations. Pure function: receives
`{ incident_id, raw_events[] }`, returns `{ status, timeline[], error?,
provider_used? }`. No write access to anything — core-api persists its output.
Uses LLM via AI Gateway; retry logic is core-api's responsibility.

**RootCauseAgent** (`rootcause-agent` Worker): Given a validated timeline and
retrieved knowledge context, produces a cited root-cause hypothesis with an
overall confidence score. May invoke `StatusCorrelator` (a genuine LLM tool
call) to check external service status if the model decides it's relevant.
Must not fabricate citations — every citation must trace back to a chunk
core-api actually provided. Returns structured result core-api persists.

**PreventionAgent** (`prevention-agent` Worker): Given a root cause and
retrieved context, produces concrete preventive recommendations with
optional references to knowledge sources. When no grounding exists in the
provided context, returns `reference: null` honestly rather than
hallucinating. No per-recommendation confidence scoring in v1.

**ModeratorAgent** (`moderator-agent` Worker): Assembles all prior agent
outputs (timeline, root cause, recommendations) into one coherent draft
report. May make exactly one optional LLM call for a narrative `summary`
paragraph — if that call fails, falls back to template assembly rather than
failing the whole stage. Passes through `needs_review` from RootCauseAgent
unchanged.

---

## 4. Data Flow — Step by Step

1. **Engineer submits incident.** `POST /api/v1/incidents` with `title` and
   `summary`. core-api creates a row in `incidents` (status=`Ingested`),
   initializes a new `IncidentRoom` DO instance at state `Ingested`, and
   returns `{ data: { id, status: "Ingested" } }`.

2. **Engineer adds events.** `POST /api/v1/incidents/{id}/events` with
   `{ timestamp?, detail }` (idempotency-keyed). core-api writes each raw
   event into `incident_events` (write-once input, unmodified). Repeatable
   any number of times. Incident stays in `Ingested`.

3. **Engineer triggers analysis.** `POST /api/v1/incidents/{id}/analyze`.
   core-api verifies incident is in a valid starting state (`Ingested`).
   Calls `TimelineAgent` RPC with all raw events collected so far.

4. **TimelineAgent runs.** Calls LLM via AI Gateway (Gemini → fallback
   OpenRouter if needed). Returns structured timeline with per-event
   confidence scores, or `{ status: "failure" }`. core-api persists result
   to `timeline_entries`. On success, advances DO state to `TimelineDone`.

5. **Validation Gate runs (deterministic, inside core-api).** Reads the
   timeline array in-memory. Checks: event count, timestamp coverage, near-
   duplicate events, unexplained time gaps.
   - **If invalid:** DO stays in `TimelineDone` (self-loop, not a dead-end
     state). Issues written to `conversations` and `agent_activity_logs`.
     Engineer can add more events and re-call `/analyze`.
   - **If valid:** DO advances to `Validated`.

6. **Core-api retrieves knowledge context.** Queries D1 `knowledge_sources`
   for top-k (default 3) chunks via cosine similarity over stored embeddings.
   On embedding failure, proceeds with empty context (logged as degraded).

7. **Core-api calls RootCauseAgent RPC.** Passes validated timeline +
   retrieved context. RootCauseAgent may invoke `StatusCorrelator` tool
   (model decides). Returns cause + confidence + evidence + `needs_review`
   flag. core-api persists to `root_causes` and advances DO to
   `RootCauseDone`.

8. **Core-api calls PreventionAgent RPC.** Passes root cause + evidence +
   knowledge context. Returns recommendations array. core-api persists to
   `recommendations` and advances DO to `PreventionDone`.

9. **Core-api calls ModeratorAgent RPC.** Passes timeline, root cause, and
   recommendations. Returns assembled draft report with optional narrative
   summary. core-api persists the full draft and advances DO to
   `AwaitReview`.

10. **Human reviews.** `POST /api/v1/incidents/{id}/review` with
    `{ reviewer_user_id, approved, modifications? }`.
    - **Approve:** DO advances to `Finalized`. (Concurrent approvals: DO
      serialization guarantees exactly one wins; the second hits the illegal-
      transition check.)
    - **Reject (target=timeline):** DO goes back to `TimelineDone`. Engineer
      adds more events, re-triggers.
    - **Reject (target=rootcause):** DO goes back to `RootCauseDone`.
      Modified root cause sent back or pipeline re-run from there.
    - **Reject (target=prevention):** DO goes back to `PreventionDone`.
      Similar re-run path.

11. **Finalized incident** becomes seed for RAG corpus (Stage 15's cross-
    incident memory). Its timeline, root cause, and recommendations are
    chunked, embedded, and stored as `type='past_incident'` in
    `knowledge_sources`.

### Validation Gate self-loop-on-failure behavior

When Validation Gate returns `valid: false`:
- DO does NOT advance past `TimelineDone`
- Issues are logged to `conversations` and `agent_activity_logs`
- `POST /incidents/{id}/events` remains callable
- `POST /incidents/{id}/analyze` re-runs Timeline + Validation from scratch
  (acceptable — running Timeline again on more complete data is fine)

---

## 5. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **RPC failure semantics untested** | Medium | Retry/timeout numbers in §3 are starting estimates, not measured values. After Stage 7 (first real LLM calls via AI Gateway), tune based on observed latency. |
| **Validation Gate's "contradictory events" check is fuzzy** | Low | Keep it a shallow deterministic check (near-duplicate timestamps with conflicting descriptions). Don't let this become an NLP problem. Document it as a known limitation, not a solved capability. |
| **Cross-incident memory and RAG sharing storage with different lifecycle needs** | Low | The `type` column (`runbook` vs `past_incident`) separates them. In a real product they'd want separate ingestion pipelines — worth noting, not worth building now. |
| **No load testing against real concurrent volume** | Medium | DO-per-incident model should scale in principle. Flag as a known gap in README rather than pretending it was validated. Not blocking for this challenge. |
| **LLM provider downtime during a pipeline run** | Medium | Four-provider architecture (Workers AI → OpenRouter → Gateway → Direct Gemini). Each has independent free quota. `callLLM` attempts all four in sequence, then returns typed error. Whole-call retry is core-api's job (3 attempts with backoff). Document that a production version would want AI Gateway-level dynamic routing as that feature matures. |
| **Prompt injection from user-supplied events** | Medium | Delineate data from instructions in prompts using clear delimiters. `knowledge_sources` ingestion is authenticated (no public upload). Document residual risk in README. |
| **Stale knowledge documents producing bad reasoning** | Low | Out of scope to build staleness detection. Document in README as known limitation (`last_reviewed_at` field + review process would address this in production). |
| **Accidental single-Worker refactoring** | Critical | Architecture Principle §1.2 (single responsibility) and §1.9 (agents never directly invoke each other) explicitly guard against collapsing the 5-worker architecture. During code review, watch for any import of agent-worker types into another agent-worker, or core-api making its own LLM call. |

---

## 6. Open Questions 

### 6a. Ingestion lives inside core-api, not its own Worker

**Confirmed.** The `knowledge_sources` table read/write, chunking, embedding,
and retrieval logic all live in core-api. There is no separate ingestion
Worker.

Rationale: Ingestion is a synchronous, deterministic side-effect of either
(a) an authenticated admin uploading a runbook, or (b) an incident reaching
`Finalized`. Neither needs worker-level isolation or independent scaling.
Putting it inside core-api keeps the deployment surface at exactly 5 Workers,
not 6.

### 6b. Routes prefixed `/api/v1` with `{ data }` / `{ error }` response envelope

**Confirmed.** Every endpoint returns:

- Success: `{ "data": <payload> }`
- Failure: `{ "error": { "code": string, "message": string } }`

All routes are under `/api/v1`. This is not repeated per-endpoint in the API
reference table — it applies universally.

### 6c. Other genuine ambiguities

1. **Event storage for TimelineAgent — what's the table?** **Resolved: a
   dedicated `incident_events` table for raw submitted events (write-once
   input), separate from `timeline_entries` (TimelineAgent's processed
   output). `conversations` remains for exchange logs only.**

2. **Soft delete implementation detail.** The soft-delete strategy says add
   `deleted_at` to `incidents` and (optionally) to `knowledge_sources`.
   Should `knowledge_sources` also use soft-delete, or is hard-delete
   acceptable since the doc says it "CAN be genuinely deleted"? **I'll go
   with soft-delete for both (uniform, makes the "delete doc, confirm
   retrieval changes" test easy to reverse) unless you prefer otherwise.**

3. **TimelineAgent receives ALL raw events, or only non-deleted ones?** When
   an incident loops back from `AwaitReview` to `TimelineDone`, should
   TimelineAgent receive all raw events ever submitted (old + new), or only
   the events submitted since the last re-trigger? **I'll assume all events
   are passed — TimelineAgent can use its own judgment to deduplicate based
   on timestamps and descriptions, giving it the full picture.**

4. **D1 migration files location.** Should migrations live in `core-api/
   migrations/` (per Wrangler convention for a single-Worker project), or at
   the repo root since D1 is shared across Workers (though only core-api
   uses it)? **Resolved: `workers/core-api/migrations/`. core-api is a
   Worker; `/packages/` is for shared code only.**

5. **`confidence_threshold_override` in RootCauseAgent input.** Per the agent
   contract, this is optional (`?`). Who sets it — the user in the API
   request, or is it always left absent and only the default 0.5 applies in
   v1? **I'll leave it optional and unused in v1 unless you tell me it
   should be front-facing from the start.**

---

