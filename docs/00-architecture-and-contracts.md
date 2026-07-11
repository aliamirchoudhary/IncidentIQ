# IncidentIQ — Architecture & Contracts Reference

**What this file is:** the canonical technical specification. `02-stage-prompts.md`
tells opencode *when* to build something and *what to verify*; this file
defines *exactly what it should look like* once built. When a stage prompt
says "per the Agent Contract" or "per the DO spec," it means this document.
If the two ever disagree, this file wins — update the stage prompt, not the
other way around, and tell me if you find a conflict.

---

## 1. Architecture Principles

These are load-bearing. Every stage's implementation should be checked
against these, not just against its own stage prompt.

1. **Product-first, not project-first.** Every interface (API endpoints,
   agent contracts, DO schema) is designed as if it will outlive this
   specific challenge submission and become a real product surface. Naming,
   versioning, and error handling get the same care whether or not anyone
   external ever actually calls them.
2. **Single Responsibility.** Every Worker, every agent, every D1 table does
   exactly one job. If you're about to add a second responsibility to
   something ("while I'm in rootcause-agent, I'll also handle..."), stop —
   that belongs somewhere else or in a new component.
3. **Stateless Workers.** The four agent workers (timeline, rootcause,
   prevention, moderator) hold zero state between invocations. Every call is
   a pure function: RPC input in, RPC output out. All state that needs to
   persist lives in the Durable Object (in-flight working state) or D1
   (durable record) — both owned exclusively by `core-api`.
4. **The Durable Object owns workflow state.** IncidentRoom is the single
   source of truth for "where is this incident right now in its lifecycle."
   No other component tracks or infers pipeline state independently.
5. **D1 owns persistence.** Anything that must survive beyond one incident's
   active working session (audit trail, finalized reports, knowledge base,
   user accounts) lives in D1, written only by core-api.
6. **RAG retrieval happens before reasoning, not during or after.**
   core-api runs retrieval and passes the results into an agent's RPC call
   as plain data. An agent never independently decides to go fetch more
   context mid-reasoning (the one exception, external tool calling in
   rootcause-agent, is a deliberately different mechanism — see §8 — and is
   not RAG).
7. **Human approval is mandatory before completion.** No code path — not a
   convenience shortcut, not an internal admin action, not a retry — reaches
   the `Finalized` state without a row in the `reviews` table proving a human
   made a decision.
8. **Agents never directly invoke another agent.** timeline-agent has no
   knowledge that rootcause-agent exists. rootcause-agent has no knowledge of
   prevention-agent. Each agent worker knows exactly three things: its own
   responsibility, its input schema, its output schema. Nothing else.
9. **All inter-agent communication goes through orchestration.** core-api is
   the only component that knows the full pipeline shape (Timeline →
   Validation → RootCause → Prevention → Moderator) and the only component
   that decides what runs next. This is what makes core-api an
   **orchestration + persistence layer**, not a reasoning layer — it never
   calls an LLM itself; all reasoning is delegated to agent workers.

If you ever catch an implementation violating one of these (an agent worker
importing another agent worker's types, an agent worker writing to D1
directly, core-api making its own LLM call instead of delegating) — that's a
bug against this spec, not a style nitpick. Fix it before moving on.

---

## 2. System Topology

```
                         ┌─────────────────────────────┐
                         │         core-api             │
                         │  (orchestration + persistence)│
                         │                               │
   HTTP/REST  ─────────▶ │  - Public REST API            │
   (clients,             │  - D1 (all tables)            │
    frontend)             │  - Durable Object (IncidentRoom)│
                         │  - Retrieval (RAG query logic) │
                         │  - Validation Gate (deterministic)│
                         │  - Auth                        │
                         └───────────┬───────────────────┘
                                     │ Service Binding RPC
                     ┌───────────────┼───────────────┬───────────────┐
                     ▼               ▼               ▼               ▼
             timeline-agent  rootcause-agent  prevention-agent  moderator-agent
             (stateless)     (stateless)      (stateless)       (stateless)
             LLM via         LLM via          LLM via           LLM via
             AI Gateway      AI Gateway +     AI Gateway        AI Gateway
                             StatusCorrelator
                             tool
```

The **Validation Gate** is deterministic logic inside core-api, not a sixth
Worker — see §3.2 for why.

Pipeline order: `Ingested → TimelineDone → Validated → RootCauseDone →
PreventionDone → AwaitReview → Finalized`, with a human-triggered loop-back
from `AwaitReview` to any of `TimelineDone / RootCauseDone / PreventionDone`,
and a validation-triggered soft-hold at `TimelineDone` (stays in that state,
doesn't advance, until re-validated).

---

## 3. Agent Contracts

Every agent below is a **stateless pure function** exposed as an RPC method
on its own Worker. Read this section before implementing any agent — the
"forbidden to change" column is not a suggestion, it's what keeps five
independently-built components from drifting into each other's
responsibilities.

### 3.1 TimelineAgent (`timeline-agent` Worker)

| | |
|---|---|
| **Purpose** | Convert raw, possibly-unordered incident events into a structured, chronologically-ordered timeline with gap/anomaly annotations. |
| **Inputs** | `{ incident_id: string, raw_events: Array<{ timestamp: string \| null, detail: string, source?: string }> }` |
| **Outputs** | `{ status: "success" \| "failure", timeline?: Array<{ time: string, event: string, confidence: number, note?: string }>, error?: string, provider_used?: string }` |
| **Allowed to change** | Nothing directly — it has no D1/DO access. It only returns data for core-api to persist. |
| **Forbidden to change** | Anything. This agent has no write access to any store; "allowed/forbidden to change" here really means "what core-api should trust from its output" — core-api trusts the returned `timeline` array as the authoritative ordering, nothing else. |
| **Failure behavior** | Any LLM failure (both providers exhausted) → return `{status: "failure", error: "..."}`. Never throw unhandled across the RPC boundary. core-api does NOT advance state on failure. |
| **Retry behavior** | core-api retries the RPC call up to 2 times (3 attempts total) with exponential backoff, only for transient errors (5xx, timeout, rate-limit signal) — not for a well-formed `{status: "failure"}` response, which is terminal and should be surfaced, not silently retried into a different failure. |
| **Timeout behavior** | core-api enforces a per-call timeout (verify current Workers subrequest/wall-time limits before hardcoding a number — start around 20-30s as a reasonable LLM-call budget and adjust based on observed real latency). On timeout, treated the same as failure. |
| **Confidence meaning** | Per-event confidence (0.0-1.0): the model's self-assessed certainty about that event's placement/interpretation given ambiguous or missing timestamp data. Not an overall incident confidence — that's RootCauseAgent's job. |
| **Example output** | ```{ "status": "success", "timeline": [{ "time": "2026-01-01T10:02:00Z", "event": "DB connection pool exhausted", "confidence": 0.9, "note": null }, { "time": "2026-01-01T10:05:00Z", "event": "API latency spike reported", "confidence": 0.6, "note": "timestamp inferred from log ordering, not explicit" }], "provider_used": "gemini" }``` |

### 3.2 ValidationGate (deterministic, lives in `core-api`, NOT a separate Worker)

| | |
|---|---|
| **Purpose** | Catch bad input before expensive LLM reasoning begins. Runs automatically after TimelineAgent completes, before RootCauseAgent is triggered. |
| **Why it's not a Worker** | It's deterministic (no LLM call), needs no isolation, and needs to read the timeline core-api just received — putting it in core-api avoids an extra RPC hop and an extra Worker to deploy/secure/monitor for logic that's a handful of `if` checks. If this logic ever grows real complexity (e.g. we add a second deterministic pass, or it starts needing its own retry/timeout semantics independent of core-api's request lifecycle), reconsider promoting it to its own Worker — but don't do that preemptively. |
| **Inputs** | The timeline array just produced by TimelineAgent (in-memory, not re-fetched). |
| **Outputs** | `{ valid: boolean, issues: Array<{ type: "missing_timestamp" \| "contradictory_events" \| "insufficient_evidence" \| "large_gap", detail: string }> }` |
| **Checks performed** (extend this list if you find more useful signals, tell me if you do): event count below a minimum threshold (default 2); more than N% of events missing timestamps; two events describing contradictory states with no time separation to explain it; a suspiciously large unexplained time gap between the incident's start and the first meaningful event. |
| **Allowed to change** | Sets `agent_activity_logs` entry (agent_name = "ValidationGate"), and if invalid, sets the incident's `validation_status` flag and writes a human-readable summary of issues into `conversations` (author='agent') so a reviewer or the submitting engineer can see exactly what's missing. |
| **Forbidden to change** | Does not touch the timeline data itself — it's read-only against what TimelineAgent produced. Does not call an LLM. Does not advance state past `TimelineDone` on success — advancing to `Validated` is core-api's job once it receives `valid: true`. |
| **Failure/retry/timeout** | N/A — deterministic, synchronous, can't meaningfully fail except a code bug, in which case it should throw a normal exception and be caught like any other core-api internal error (500, logged, incident stays in TimelineDone). |
| **On invalid** | Incident stays in `TimelineDone` (not a new dead-end state). `POST /incidents/{id}/events` remains callable to add more data. Re-calling `POST /incidents/{id}/analyze` re-runs Timeline + Validation from scratch (acceptable — Timeline re-running on slightly more complete data is fine and often desirable). |
| **On valid** | State advances `TimelineDone → Validated`, then core-api proceeds to trigger RootCauseAgent (Stage 13's auto-chain includes this step). |
| **Example output** | ```{ "valid": false, "issues": [{ "type": "missing_timestamp", "detail": "3 of 5 events have no timestamp" }, { "type": "insufficient_evidence", "detail": "only 2 events submitted, minimum is 2 but both are near-duplicate descriptions" }] }``` |

### 3.3 RootCauseAgent (`rootcause-agent` Worker)

| | |
|---|---|
| **Purpose** | Produce a cited, confidence-scored root-cause hypothesis, grounded in retrieved knowledge, optionally informed by an external status-check tool. |
| **Inputs** | `{ incident_id: string, timeline: Array<...>, retrieved_context: Array<{ chunk_id: string, title: string, content: string, score: number }>, confidence_threshold_override?: number }` |
| **Outputs** | `{ status: "success" \| "failure", cause?: string, confidence?: number, evidence?: string, tool_invocations?: Array<{ tool: string, input: object, output: object }>, needs_review?: boolean, error?: string, provider_used?: string }` |
| **Allowed to change** | Nothing directly (no D1/DO access) — returns data for core-api to persist. May invoke the StatusCorrelator tool (read-only external HTTP call, no state mutation anywhere). |
| **Forbidden to change** | Cannot fabricate a citation to a `retrieved_context` chunk that wasn't actually provided to it. If it references a source, that source must be traceable to what core-api passed in. |
| **Failure/retry/timeout** | Same pattern as TimelineAgent (§3.1). |
| **Confidence meaning** | Overall confidence (0.0-1.0) that the stated cause is correct given available evidence. `< 0.5` (the named `CONFIDENCE_THRESHOLD` constant, overridable per-user per Stage 15) triggers `needs_review: true`. |
| **Example output** | ```{ "status": "success", "cause": "Database connection pool exhaustion under load spike", "confidence": 0.78, "evidence": "Matches runbook 'connection-pool-exhaustion' (chunk_id: kb_003); timeline shows connection errors 90s after traffic increase", "tool_invocations": [], "needs_review": false, "provider_used": "gemini" }``` |

### 3.4 PreventionAgent (`prevention-agent` Worker)

| | |
|---|---|
| **Purpose** | Given a root cause, produce concrete, cited preventive recommendations. |
| **Inputs** | `{ incident_id: string, root_cause: string, root_cause_evidence: string, retrieved_context: Array<{ chunk_id, title, content, score }> }` |
| **Outputs** | `{ status: "success" \| "failure", recommendations?: Array<{ recommendation: string, reference: string \| null }>, error?: string, provider_used?: string }` |
| **Allowed / forbidden to change** | Same pattern as RootCauseAgent — no direct persistence, honest `reference: null` when nothing groundable, never a fabricated citation. |
| **Failure/retry/timeout** | Same pattern as §3.1. |
| **Confidence meaning** | N/A at the per-recommendation level for v1 — recommendations aren't individually confidence-scored; the incident's overall `needs_review` flag already came from RootCauseAgent. (Flag for future: if this proves too coarse, add per-recommendation confidence later — don't over-build it now.) |
| **Example output** | ```{ "status": "success", "recommendations": [{ "recommendation": "Increase connection pool max size from 20 to 50 and add pool-utilization alerting at 80%", "reference": "kb_003" }, { "recommendation": "Add circuit breaker on the payments-provider client", "reference": null }] }``` |

### 3.5 ModeratorAgent (`moderator-agent` Worker)

| | |
|---|---|
| **Purpose** | Assemble all prior agent outputs into one coherent, structured draft report. |
| **Inputs** | `{ incident_id: string, timeline: [...], root_cause: {...}, recommendations: [...] }` |
| **Outputs** | `{ status: "success" \| "failure", report: { summary: string, timeline: [...], root_cause: {...}, recommendations: [...], needs_review: boolean }, error?: string }` |
| **Allowed / forbidden to change** | No persistence access. May optionally make ONE LLM call to write a human-readable narrative `summary` paragraph — must not alter or re-interpret the underlying structured data from prior agents, only narrate it. |
| **Failure/retry/timeout** | Same pattern as §3.1. If the optional narrative LLM call fails, fall back to a template-assembled summary rather than failing the whole stage — narrative quality is a nice-to-have, not a hard dependency. |
| **Confidence meaning** | Passes through RootCauseAgent's `needs_review` flag unchanged; does not compute its own confidence. |
| **Example output** | ```{ "status": "success", "report": { "summary": "On Jan 1, a database connection pool exhaustion event...", "timeline": [...], "root_cause": {...}, "recommendations": [...], "needs_review": false } }``` |

---

## 4. Durable Object Deep-Dive (`IncidentRoom`, in `core-api`)

### 4.1 State machine

```
Ingested ──(TimelineAgent success)──▶ TimelineDone
TimelineDone ──(ValidationGate: valid)──▶ Validated
TimelineDone ──(ValidationGate: invalid)──▶ TimelineDone   [self-loop, stays put]
Validated ──(RootCauseAgent success)──▶ RootCauseDone
RootCauseDone ──(PreventionAgent success)──▶ PreventionDone
PreventionDone ──(ModeratorAgent success)──▶ AwaitReview
AwaitReview ──(human: approve)──▶ Finalized
AwaitReview ──(human: reject, target=timeline)──▶ TimelineDone
AwaitReview ──(human: reject, target=rootcause)──▶ RootCauseDone
AwaitReview ──(human: reject, target=prevention)──▶ PreventionDone
Finalized ──▶ (terminal, no further transitions)
```

### 4.2 Illegal transitions (must be rejected with a clear error)

Any transition not explicitly listed in §4.1 — most importantly: nothing may
jump directly to `Finalized` except from `AwaitReview` via an approval, and
nothing may skip `Validated` on the way from `TimelineDone` to
`RootCauseDone`. Write the transition-check as an explicit allow-list (only
these exact from→to pairs succeed), not a deny-list — an allow-list can't
accidentally permit a new bad transition when someone adds a state later.

### 4.3 Recovery after crash

Durable Objects persist their storage across evictions/restarts by design —
verify this is still accurate for the current Cloudflare DO storage API
before relying on it, but the practical requirement is: if a Worker instance
handling an incident crashes mid-request (e.g. mid-RPC-call to an agent
worker) before the state transition commits, the incident should be found
afterward in its **last successfully committed state**, not a half-updated
one. This means: write incoming agent results to DO storage and advance
state as a single atomic operation (or as close to atomic as the storage API
allows — check whether the current API offers transactional writes across
multiple keys, and use that if so), not as two separate writes where a crash
between them leaves things inconsistent.

### 4.4 Concurrency: two review requests at once

Scenario: two reviewers both open the same AwaitReview incident and both hit
"Approve" within the same second. Requirement: exactly ONE of these
succeeds; the second must fail cleanly (not corrupt state, not silently
double-log, not finalize twice).

Mechanism: Durable Objects process requests to the same instance
**serially** by default (this is a core DO guarantee — verify it's still
accurate, but it has historically been the main reason to use a DO at all
for this kind of coordination). Design the review-handling method so the
SECOND request, executing after the first has already transitioned the
incident to `Finalized`, hits the "illegal transition" check from §4.2
(since the incident is no longer in `AwaitReview`) and is rejected the same
way an out-of-order review attempt would be. Confirm this behavior with an
explicit test: fire two review requests concurrently (e.g. `Promise.all`
against the deployed instance) and confirm exactly one succeeds.

### 4.5 Locking

Given DO's serial-execution guarantee (§4.4), you likely do NOT need
application-level locking on top of it for our access patterns — that
guarantee IS the lock. Don't add a redundant locking layer unless you find a
specific case where DO's serial execution isn't sufficient (e.g. if you
introduce genuinely async background work inside the DO that outlives a
single request — flag this to me if you hit it, don't silently add a locking
mechanism to work around something DO's model already handles).

### 4.6 Version numbers

Add a `version` integer field to the DO's stored state, incremented on every
successful state transition. This isn't for locking (see §4.5) — it's for
**observability and debugging**: every write to `agent_activity_logs`
related to this incident should include the DO's version number at the time
of that write, so if something looks wrong later, you can reconstruct the
exact sequence of state changes rather than just the final state.

---

## 5. D1 Schema Deep-Dive

For every table: purpose, who writes, who reads, retention, and scaling
notes, on top of the columns/indexes/FKs already defined in Stage 2.

| Table | Purpose | Writes | Reads | Retention | Scaling notes |
|---|---|---|---|---|---|
| `users` | Account + auth identity | core-api (signup/admin) | core-api (auth check) | Indefinite | Fine at any scale for this project's size; would need sharding only at a scale far beyond this challenge |
| `sessions` | Active login/API sessions | core-api (on auth) | core-api (auth check) | Expire per `expires_at`; a cleanup job (future work, not required now) would delete expired rows periodically | Could move to KV/Durable Object if session volume ever became large; D1 is fine for the expected scale here |
| `incidents` | Core incident record + status | core-api only | core-api, frontend (via API) | Indefinite (this IS the product's record of truth) | Add pagination to any future "list all incidents" endpoint before this table gets large |
| `incident_events` | Raw, unprocessed events as submitted by an engineer via `POST /incidents/{id}/events` — write-once, immutable input record | core-api (on event submission, dual-written alongside the DO's working state) | core-api (reads all rows for an incident and passes them as `raw_events` in TimelineAgent's RPC input — TimelineAgent never queries D1 itself) | Indefinite | This is the "raw input" record; `timeline_entries` below is deliberately separate as the "processed output" record — don't conflate them |
| `timeline_entries` | TimelineAgent's processed, ordered, confidence-annotated timeline (NOT the raw submitted events — see `incident_events` above) | core-api, only after TimelineAgent RPC returns successfully | core-api (report assembly, audit) | Indefinite | — |
| `root_causes` | Durable root-cause record per incident | core-api (on RootCauseAgent success) | core-api | Indefinite | — |
| `recommendations` | Durable recommendations per incident | core-api (on PreventionAgent success) | core-api | Indefinite | — |
| `reviews` | Human review decisions | core-api (on `/review`) | core-api, frontend | Indefinite (this is the audit/accountability record — never delete) | — |
| `conversations` | Human↔system exchange log per incident | core-api (ingestion, validation, review) | core-api, frontend | Indefinite | — |
| `knowledge_sources` | RAG corpus (runbooks, past incidents, embeddings) | core-api (ingestion pipeline, and automatically on incident finalization for cross-incident memory) | core-api (retrieval) | Indefinite, but see staleness handling in §6.10 | Embeddings stored as JSON in D1 is fine at this project's corpus size (dozens to low hundreds of documents); migrate to Vectorize if the corpus grows into the thousands |
| `agent_activity_logs` | Full audit trail of every agent/validation/review action | core-api (after every agent RPC call and every review action) | core-api, dashboard queries | Indefinite (audit trail) | This table grows fastest — add an index on `incident_id` and `created_at` from day one (already required in Stage 2), and consider a retention/archival policy if this ever runs long-term in production (not required for the challenge, worth noting in the README as a known future consideration) |

### 5.1 Soft delete strategy

Nothing in this system does a hard delete of an `incidents` row or anything
tied to it (`timeline_entries`, `root_causes`, `recommendations`, `reviews`,
`conversations`) — these are the audit/product record. If a "delete"
capability is ever needed (e.g. a test incident cluttering the demo), add a
`deleted_at` nullable timestamp column to `incidents` and filter it out of
normal queries, rather than actually removing the row. `knowledge_sources`
CAN be genuinely deleted (documents get retired/replaced), but even there,
prefer a soft `deleted_at` so retrieval can be proven to correctly exclude
deleted documents (useful for the Stage 9 "delete a document, confirm
retrieval changes" test — soft delete makes that test easy to reverse).

### 5.2 Migration strategy

All schema changes go through Wrangler D1 migrations (never manual `ALTER
TABLE` against the dashboard). Every migration file gets a short comment at
the top explaining what changed and why. Migrations are applied to `--local`
during development and to `--remote` at the specific checkpoints called out
in the stage prompts and manual setup steps (not batched up and applied all
at once at the end).

---

## 6. RAG Deep-Dive

1. **Sources.** Runbooks: hand-authored seed documents for this project
   (Stage 9), tagged `type='runbook'`. Historical incidents: automatically
   ingested from `incidents`/`root_causes`/`recommendations` once an
   incident reaches `Finalized` (Stage 15's cross-incident memory feature),
   tagged `type='past_incident'`.
2. **Chunk size & overlap.** Paragraph-level chunking (roughly 150-400
   words per chunk is a reasonable target — don't over-tune this for a
   corpus this small). A small overlap (e.g. one sentence of context
   carried into the next chunk) helps avoid losing meaning at a chunk
   boundary; implement this if straightforward, skip it if it adds real
   complexity for a corpus this size — tell me which you did.
3. **Metadata.** Every chunk carries: `source_id` (which `knowledge_sources`
   row it came from), `type`, `title`, `tags`. Retrieval results should
   always include enough metadata for an agent's citation to be meaningful
   ("per runbook X"), not just a bare chunk of text.
4. **Embedding model.** A Workers AI embedding model, called through AI
   Gateway (verify current model catalog/name before hardcoding — don't
   assume a specific model name from training data is still current).
5. **Retrieval strategy & top-k.** Cosine similarity over stored embeddings,
   k=3 default (make this a named constant, not a magic number scattered
   across call sites).
6. **Re-ranking.** Not required for v1 given this corpus's small size (top-k
   cosine similarity alone is sufficient signal at this scale) — but design
   the retrieval function so a re-ranking step could be inserted later
   without changing its external interface (i.e. `retrieveRelevantKnowledge`
   should return a plain ranked array; whatever future re-ranker exists
   would slot in as a post-processing step on that array, not require
   restructuring the function itself).
7. **Hallucination reduction.** Two mechanisms already specified elsewhere,
   restated here for completeness: (a) RootCauseAgent's prompt explicitly
   instructs it to ground claims in provided reference material and to flag
   when extrapolating beyond it (§3.3); (b) it's structurally impossible for
   an agent to cite a chunk it wasn't given, since core-api only passes in
   the actual top-k retrieved results — there's no path for the model to
   "cite" something it never saw.
8. **Citations.** An agent's `evidence`/`reference` field should name the
   specific `chunk_id`/`source title` it drew from — core-api can resolve
   this back to a real `knowledge_sources` row for display in the frontend
   and README demo, rather than the citation being an opaque string.
9. **Updates & deletions.** Updating a `knowledge_sources` document means
   re-chunking and re-embedding it (delete old chunks for that source,
   insert new ones) — don't try to diff/patch embeddings. Deletion uses the
   soft-delete pattern from §5.1; retrieval must filter out
   soft-deleted rows.
10. **Staleness detection.** Out of scope to build for this challenge, but
    document it as a known limitation in the README (per the honest,
    weaknesses-named-explicitly spirit of this document's Appendix): a
    production version would want a
    `last_reviewed_at` field on `knowledge_sources` and a process for
    flagging documents that haven't been reviewed in N months, since
    runbooks drift out of date with the systems they describe. Noting this
    in the README costs nothing and shows the thinking was considered even
    though building it isn't warranted for a 10-12 day submission.

---

## 7. LLM Strategy

- **Preferred provider:** Google Gemini (2.5 Flash free tier, or whatever
  the current comparable free-tier Gemini model is — verify current model
  names before hardcoding). Chosen over OpenRouter-as-primary because it's a
  single stable provider with a predictable free quota, versus OpenRouter's
  rotating pool of free open models, which is better suited to being a
  fallback/diversity option than a primary dependency.
- **Fallback provider:** OpenRouter free-models pool.
- **Future (explicitly out of scope to build now, note in README roadmap):**
  richer Cloudflare AI Gateway-level dynamic routing/caching as that feature
  matures, rather than the current application-level try/catch fallback.
- **Timeouts:** per-call timeout enforced at the `callLLM` utility level
  (see Agent Contracts §3 for the per-agent number) — don't let a hung
  provider call hold an agent worker (and therefore the whole chain) open
  indefinitely.
- **Retry policy:** `callLLM` itself does NOT retry across providers
  automatically forever — one attempt at the preferred provider, on failure
  one attempt at the fallback provider, then give up and return a typed
  error. Retrying the WHOLE agent call (not just the LLM call) is core-api's
  job, per each Agent Contract's "Retry behavior" row — keep these two retry
  layers conceptually separate (provider fallback vs. whole-call retry) so
  neither accidentally multiplies the other into excessive retry storms.
- **Temperature:** low-to-moderate (e.g. 0.2-0.4) for TimelineAgent and
  RootCauseAgent, since consistency and grounding matter more than
  creativity here. Slightly higher is acceptable for ModeratorAgent's
  optional narrative summary, if a more natural-reading paragraph is
  desired. Pick specific values and document them as named constants, don't
  leave them as unlabeled magic numbers in each agent's prompt-construction
  code.
- **Max tokens:** enforced per-call via `callLLM`'s `maxTokens` parameter
  (already required since Stage 5) — pick sensible per-agent defaults
  (Timeline/RootCause/Prevention need more room than Moderator's narrative
  paragraph) and document them.
- **Structured output / JSON mode:** use the provider's structured-output or
  JSON-mode feature if currently available for your chosen models (verify
  current support — this varies by provider/model and changes over time)
  rather than relying purely on prompt instructions plus manual parsing.
  If structured output isn't reliably available for the free-tier
  models you're using, fall back to careful prompt instructions plus
  defensive parsing (validate the shape, don't assume the model always
  returns perfect JSON) — tell me which path you ended up on.

---

## 8. Tool Contracts

**Important distinction** (this reconciles a naming difference from an
earlier review pass): because our architecture centralizes all D1/persistence
access in core-api (Architecture Principle §1.9), most of what might
naturally be called a "tool" in a simpler architecture is actually an
**orchestration-internal function inside core-api**, not something exposed
to an LLM's tool-calling mechanism. Only one thing in this system is a true
LLM-invoked tool. Both categories are documented below for completeness.

### 8.1 Orchestration-internal functions (core-api only, not LLM tools)

| Function | Inputs | Outputs | Errors | Who may call |
|---|---|---|---|---|
| `RetrieveRunbooks` / `RetrieveSimilarIncidents` / `SearchKnowledgeBase` | query text, k | ranked chunks with scores | embedding-call failure (propagates as a typed error, degrades gracefully — see below) | core-api only, internally, before calling rootcause-agent/prevention-agent or serving `/incidents/similar` |
| `StoreTimeline` | timeline array, incident_id | write confirmation | D1/DO write failure | core-api only, after TimelineAgent RPC returns |
| `StoreDraft` | assembled report, incident_id | write confirmation | D1/DO write failure | core-api only, after ModeratorAgent RPC returns |

These are plain internal functions/modules, not RPC-exposed, not
LLM-callable — an LLM never "decides" to invoke `StoreTimeline`; core-api
calls it deterministically as part of persisting an agent's result.

**Graceful degradation:** if retrieval fails (e.g. the embedding call
through AI Gateway errors), core-api should proceed with an empty
`retrieved_context` array rather than failing the whole RootCauseAgent call
— the agent's prompt already instructs it to flag when it's reasoning
without strong grounding, so a retrieval outage degrades quality rather than
availability. Log this degradation clearly in `agent_activity_logs` so it's
visible, not silent.

### 8.2 True LLM tool (exposed via Agents SDK tool-calling, model decides whether to invoke)

| Tool | Inputs (model-provided) | Outputs | Errors | Who may call |
|---|---|---|---|---|
| `StatusCorrelator` | a service/provider name the model believes may be relevant, inferred from the timeline | `{ service: string, status: "operational" \| "degraded" \| "outage" \| "unknown", checked_at: string }` | network/timeout/unrecognized-service → returns `status: "unknown"` rather than throwing, so the agent can proceed without this signal | rootcause-agent, and only rootcause-agent — the model itself decides whether to call it, per Stage 10's requirement that this be genuine LLM-driven tool use |

---

## 9. API Design Reference

Base path: `/api/v1` (per the Stage 0 decision). Response envelope:
`{ "data": <payload> }` on success, `{ "error": { "code": string, "message":
string } }` on failure — every endpoint below follows this shape; it is not
repeated per-endpoint below for brevity, but it applies to all of them.

| Endpoint | Purpose | Auth | Idempotent? | Key validation | Key error cases |
|---|---|---|---|---|---|
| `POST /incidents` | Create a new incident | Bearer token | Best-effort (client idempotency key optional) | `title`, `summary` required, non-empty | 400 missing fields, 401 unauthenticated |
| `POST /incidents/{id}/events` | Add a raw timeline event (stored in `incident_events`, dual-written to the DO's working state — NOT `timeline_entries`, which is TimelineAgent's later processed output, see §5) | Bearer token | Yes — required, idempotency key mandatory or derived | `timestamp` (nullable, but flagged if missing per Validation Gate), `detail` required | 400 missing fields, 404 unknown incident, 401 unauthenticated |
| `GET /incidents/{id}` | Fetch incident metadata | Bearer token | N/A (read) | — | 404 unknown incident, 401 unauthenticated |
| `GET /incidents/{id}/report` | Fetch current (partial or full) report | Bearer token | N/A (read) | — | 404 unknown incident |
| `POST /incidents/{id}/analyze` | Trigger the agent pipeline | Bearer token | Not idempotent in the sense of repeatable-without-effect (it advances state), but safe to call again if the incident is in a state where analysis makes sense — reject clearly otherwise | Incident must be in a state where triggering makes sense (`Ingested` or `TimelineDone` for a validation retry) | 409 if incident is already past the point analysis applies, 404 unknown incident |
| `POST /incidents/{id}/review` | Human approve/reject/modify | Bearer token | No — this is a one-shot state-changing action per §4.2's strict transition rules | `reviewer_user_id`, `approved` required; `modifications` optional | 409 if not in `AwaitReview` (the anti-bypass check from Stage 14), 400 malformed body |
| `GET /incidents?status=` | List incidents by status | Bearer token | N/A (read) | `status` must be a known state value | 400 invalid status value |
| `GET /incidents/similar?query=` | Cross-incident semantic search | Bearer token | N/A (read) | `query` required, non-empty | 400 missing query |

---

## 10. Frontend Philosophy

The React frontend (`/client`) contains **zero business logic**. Every rule
about state transitions, validation, confidence thresholds, or review
enforcement lives in core-api and is enforced there — the frontend only
reflects what the API tells it. Concretely, the frontend's job is limited
to:

- **Uploads** — forms that submit data to the API (incident creation,
  timeline events).
- **Review** — presenting a draft report and collecting a human decision,
  which it sends to the API verbatim; it does not itself decide whether a
  review is valid.
- **Visualization** — rendering the timeline, root cause, recommendations,
  and status in a readable way.
- **Status** — showing where an incident currently is in its lifecycle.

If a frontend component ever needs to duplicate a rule the API already
enforces (e.g. "don't show the Approve button unless status is
AwaitReview") — that's fine as a *UX convenience* (hiding a button that
would fail anyway), but the API-side enforcement must exist independently
and must be what's actually trusted. Never let the frontend be the only
place a rule is enforced.

---

## Appendix: Honest Design Review

Written as if by a Cloudflare reviewer, a senior backend engineer, a product
architect, and a startup CTO looking at this spec before a line of code
exists. This is a genuine list of remaining weaknesses, not a formality —
see my chat response for the full discussion; summarized here for the
permanent record:

1. **RPC failure semantics between core-api and agent workers are specified
   but not yet battle-tested.** The retry/timeout numbers in §3 are
   reasonable starting points, not measured values — expect to tune them
   after Stage 7 once you have real latency data from actual LLM calls
   through AI Gateway.
2. **The Validation Gate's checks (§3.2) are a reasonable starting set, not
   exhaustive.** "Contradictory events" in particular is a fuzzy rule to
   implement deterministically — it may end up being a shallow check
   (duplicate/near-duplicate timestamps with conflicting descriptions)
   rather than genuine semantic contradiction detection. That's fine for
   this project's scope; don't let opencode over-engineer this into an NLP
   problem.
3. **Cross-incident memory (Stage 15) and the RAG corpus share storage but
   have different lifecycle needs** (runbooks are curated, past incidents
   are auto-generated) — the `type` column distinguishes them, but if this
   ever became a real product, these would likely want separate ingestion
   pipelines with different quality controls. Not worth building now, worth
   knowing.
4. **The product/SaaS vision (see `05-product-vision-roadmap.md`) is
   deliberately not reflected in any build stage.** This is a considered
   choice, not an oversight — see that document's opening note for why.
5. **No load testing is planned against real concurrent incident volume.**
   The DO-per-incident model should scale fine in principle (each incident
   is an independent DO instance), but this project's testing stage
   (Stage 19) covers correctness, not throughput — flag this as a known gap
   in the README rather than pretending it was validated.

None of these block calling the documentation "final" — they're the honest
list of things a real production rollout (beyond this challenge) would need
to address next, and naming them explicitly is more credible than pretending
the design has no edges.
