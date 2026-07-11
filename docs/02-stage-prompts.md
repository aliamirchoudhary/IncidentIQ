# IncidentIQ — Stage-by-Stage Build Prompts (for opencode)

**Revision note (third pass):** Two changes on top of the last version:
1. **New Stage 8: Validation Gate**, inserted between Timeline Agent and the
   RAG pipeline, per the reviewed architecture change — a deterministic
   check (no LLM) that catches a bad timeline before expensive reasoning
   builds on top of it. Everything from the old Stage 8 onward is
   renumbered +1. **22 stages total now, 0–21.**
2. **LLM provider order flipped:** Gemini is now primary, OpenRouter is
   fallback (was the reverse). See `00-architecture-and-contracts.md` §7 for
   the reasoning.

This file now works alongside two new reference documents:
- **`00-architecture-and-contracts.md`** — the technical spec: architecture
  principles, exact agent contracts, Durable Object internals, D1 schema
  detail, RAG detail, LLM strategy, tool contracts, API reference, frontend
  philosophy. When a stage prompt says "per the Agent Contract," this is
  where that lives.
- **`04-quality-ops-security.md`** — testing taxonomy, observability spec,
  security spec, code quality standards. Stages 17–19 point back to this
  rather than repeating it.

Stage prompts below stay focused on *sequencing and verification*; the
*exact shape* of what's being built lives in those two reference docs, so
opencode should read the relevant section before starting each stage — this
is called out explicitly in each stage prompt now.

**How to use this file:** work through stages in order. Paste the boxed
prompt into opencode, let it work, run the Acceptance Checks yourself, do
the matching section in `03-manual-setup-steps.md`, commit, move on.

---

## Non-negotiable ground rules (referenced by every stage, stated once here)

- **Stack correction:** "MERN" means React frontend only. No Express, no
  MongoDB. Backend = Cloudflare Workers. Database = D1. State = Durable
  Objects.
- **Multi-worker, product-first architecture.** `core-api` is an
  orchestration + persistence layer only — it never calls an LLM itself.
  The four analysis agents (Timeline, RootCause, Prevention, Moderator) are
  separate Workers, stateless, called via Service Binding RPC, and **never
  call each other** — only core-api decides what runs next. The Validation
  Gate (new Stage 8) is deterministic logic inside core-api, not a Worker.
  Full reasoning in `00-architecture-and-contracts.md` §1.
- **API-first, thin frontend.** core-api's REST API is the real product
  (versioned under `/api/v1`, consistent response envelope — see
  `00-architecture-and-contracts.md` §9). The React frontend (Stage 16) is
  a deliberately minimal demonstration client — never let it grow beyond
  what a stage prompt asks for.
- **Deploy early, deploy often.** Specific stages redeploy to production and
  re-verify remotely well before the final deployment stage — don't skip
  these checkpoints.
- **No mocked LLM calls, ever**, past Stage 5. **LLM order: Gemini primary,
  OpenRouter fallback** (flipped from an earlier draft — see
  `00-architecture-and-contracts.md` §7).
- **RAG must be real retrieval** — provably corpus-dependent, not "paste
  everything into the prompt." See `00-architecture-and-contracts.md` §6.
- **HITL must be structurally enforced** at the API/state-machine level.
- **Idempotency matters** wherever a stage says so.
- **Every agent's exact input/output shape must match its contract** in
  `00-architecture-and-contracts.md` §3 — don't improvise a different shape
  because it seemed convenient in the moment.
- **Code quality bar applies from Stage 1 onward**, not just at the end —
  see `04-quality-ops-security.md` §4 (no TODOs, no dead code, typed
  interfaces, small functions, meaningful commits).
- **opencode must ask rather than silently assume** whenever something is
  genuinely ambiguous.
- **STOP at the end of every stage.** Don't start the next stage's work.
- **End-of-stage report, every stage, no exceptions:** when opencode
  finishes a stage's work, before you move on, it must report back:
  *Architecture changes* (anything that touches `00-architecture-and-
  contracts.md`'s content — flag it, don't silently drift from the spec),
  *Files created*, *Files modified*, *Commands executed*, *Tests performed*,
  *Known limitations*. If a stage's prompt doesn't explicitly repeat this
  requirement, it still applies — it's a ground rule, not a per-stage
  option.

---

## Stage 0 — Architecture Lock-In (No Code)

```
STAGE 0 — ARCHITECTURE LOCK-IN (NO CODE)

OBJECTIVES:
- Freeze the system architecture in writing before any implementation code
  exists.
- Confirm you've read and understood 00-architecture-and-contracts.md,
  which now contains the full technical spec (architecture principles,
  agent contracts, DO internals, D1 detail, RAG detail, LLM strategy, tool
  contracts, API reference, frontend philosophy) — this stage's job is to
  confirm understanding and surface any remaining ambiguity, not to
  re-derive the architecture from scratch.

SUCCESS CRITERIA:
- All six output sections below are produced, reviewed, and confirmed by me.
- Every open question gets a real answer from me, not a default.

DELIVERABLES:
- ARCHITECTURE.md at the repo root (your six sections, saved).

CONSTRAINTS:
- No code, no folders, this stage.
- Do not contradict 00-architecture-and-contracts.md — if you think
  something in it is wrong, say so explicitly as a question, don't quietly
  build something different.

We are about to build IncidentIQ: a Cloudflare-native, multi-agent AI
incident postmortem and root-cause-analysis platform. Before any code, read
00-architecture-and-contracts.md in full, then produce:

1. Architecture Summary — restate the system in your own words, proving you
   understood it, not copy-pasting.
2. Component List — every Worker project, every DO class, every D1 table,
   every Service Binding, named explicitly, including the new Validation
   Gate (deterministic, lives in core-api, not a Worker — explain why per
   §3.2 of the architecture doc).
3. Agent Responsibilities — one paragraph per agent, matching the contracts
   in §3 of the architecture doc, in your own words.
4. Data Flow — numbered, step-by-step, "engineer submits an incident"
   through "final report approved," including the Validation Gate step and
   its self-loop-on-failure behavior.
5. Risks & Mitigations — anything about this design that concerns you, and
   how we'll handle it.
6. Open questions — specifically confirm: (a) ingestion lives inside
   core-api, not its own Worker; (b) routes are prefixed /api/v1 with the
   {data}/{error} response envelope from the architecture doc's API
   reference; (c) any other genuine ambiguity you spot.

STOP after producing the six sections. Wait for my confirmation before
Stage 1.
```

**Acceptance checks:**
- [ ] You actually read `00-architecture-and-contracts.md` yourself before reviewing opencode's summary — you need to be able to tell if its restatement is actually correct, not just plausible-sounding
- [ ] Every question got a real answer from you
- [ ] `ARCHITECTURE.md` saved at repo root

**Commit message:** `docs: architecture lock-in (ARCHITECTURE.md)`

---

## Stage 1 — Monorepo Skeleton (5 Workers + Shared Package) — Deploy Immediately

```
STAGE 1 — MONOREPO SKELETON (LOCAL + PRODUCTION)

OBJECTIVES:
- Every Worker project exists and deploys.
- Service Bindings work, proven both locally and on real Cloudflare
  production, using trivial stub code.

SUCCESS CRITERIA:
- Local ping-all round-trip works across all four agent workers.
- The identical round-trip works against the deployed production URLs.

DELIVERABLES:
- /workers/core-api, /workers/timeline-agent, /workers/rootcause-agent,
  /workers/prevention-agent, /workers/moderator-agent, /packages/shared,
  /client (stub only), all committed and deployed.

CONSTRAINTS:
- No business logic yet — stubs only.
- No express/mongoose anywhere.
- Follow the /api/v1 + response-envelope convention from
  00-architecture-and-contracts.md §9 starting with this stage's placeholder
  route, even though it's trivial.

Per ARCHITECTURE.md and 00-architecture-and-contracts.md, scaffold the full
monorepo skeleton.

FOLDER STRUCTURE (tell me if you deviate and why):
  /workers/core-api, /workers/timeline-agent, /workers/rootcause-agent,
  /workers/prevention-agent, /workers/moderator-agent, /packages/shared,
  /client (thin stub only — real work is Stage 16), /ARCHITECTURE.md, /docs

REQUIREMENTS:
1. npm or pnpm workspaces at root so /packages/shared is importable by all
   five worker projects without a registry publish step.
2. Each worker: its own wrangler.jsonc, today's compatibility_date,
   "nodejs_compat" flag. The four agent workers export a WorkerEntrypoint
   class with one placeholder RPC method (`ping()` returning "pong") —
   verify current correct syntax for named RPC entrypoints.
3. core-api's wrangler.jsonc declares Service Bindings to all four agent
   workers. Verify current binding syntax.
4. Prove Service Bindings work LOCALLY via GET /api/v1/debug/ping-all on
   core-api, calling .ping() via RPC on all four. Verify the current
   Wrangler multi-worker local dev command (multiple -c flags) and give me
   the exact command.
5. Scaffold /client as a bare React + Vite app with one placeholder page
   hitting core-api's health/ping-all endpoint. Nothing beyond this single
   page — the frontend stays a stub until Stage 16.
6. Root .gitignore covering node_modules, .wrangler, .env*, dist/build.

THEN DEPLOY TO PRODUCTION, TODAY:
7. Deploy all four agent workers first, then core-api (Service Bindings
   need them to exist first — verify current deploy ordering behavior).
8. Re-run the exact same ping-all proof against the DEPLOYED production
   URLs. This is the highest-risk unknown in the whole architecture — catch
   a production Service-Binding problem now, with five lines of stub code,
   not at Stage 20.
9. Tell me the production core-api URL and confirm the remote result.

STOP after both local and production ping-all work. Wait for me before
Stage 2.
```

**Acceptance checks:**
- [ ] Local ping-all works
- [ ] **Production ping-all works** — non-negotiable, don't skip
- [ ] Client loads and shows a response that traveled the real chain
- [ ] No express/mongoose in any package.json
- [ ] `/packages/shared` importable from at least one worker

**Commit message:** `chore: scaffold 5-worker monorepo with service-binding RPC skeleton, deployed to production`

---

## Stage 2 — D1 Schema & Migrations — Local + Remote

```
STAGE 2 — D1 SCHEMA & MIGRATIONS (LOCAL + REMOTE)

OBJECTIVES:
- Every mandatory table exists in D1, per the full spec in
  00-architecture-and-contracts.md §5 (now 11 tables — a new
  `incident_events` table was added after Stage 0 review to separate raw
  submitted events from TimelineAgent's processed output; read §5's updated
  table before starting), owned exclusively by core-api.

SUCCESS CRITERIA:
- All 11 tables exist, with FKs/indexes, in BOTH local and remote D1.
- schema.md maps every mandatory challenge requirement to a table.

DELIVERABLES:
- workers/core-api/migrations/*.sql, docs/schema.md.

CONSTRAINTS:
- D1 lives only in core-api — no other worker gets a binding.
- Migrations live in workers/core-api/migrations/ — NOT
  packages/core-api/migrations/. core-api is a Worker (under /workers/),
  not a shared package (/packages/ is reserved for /packages/shared only).
- Apply the soft-delete pattern (§5.1 of the architecture doc) to
  `incidents` and `knowledge_sources` from this migration, not retrofitted
  later (a `deleted_at` nullable column on each).
- Follow the migration strategy in §5.2 (checked-in migrations only, never
  manual dashboard edits, comment every migration file).
- `incident_events` (raw input) and `timeline_entries` (TimelineAgent's
  processed output) are deliberately separate tables — do not merge them.

Read 00-architecture-and-contracts.md §5 in full before writing this
migration — it specifies purpose/columns/indexes/FKs/retention for every
table, which this stage should match exactly, not re-derive.

REQUIREMENTS:
- The 11 tables and their purposes are fully specified in the architecture
  doc §5 — implement them as specified, including the `deleted_at` columns,
  the `embedding` nullable column on knowledge_sources (populated in
  Stage 9), and the new `incident_events` table (id, incident_id FK,
  timestamp nullable, detail, source optional, idempotency_key, created_at).
- `wrangler d1 migrations create <db-name> init_schema` — verify current
  syntax.
- Apply to BOTH `--local` and `--remote` this stage, confirm both by
  querying sqlite_master against each.
- docs/schema.md mapping every mandatory requirement (Users/Sessions/
  Conversations/Human reviews/Knowledge sources/Agent activity logs) to its
  table.

STOP after schema + migration exist locally AND remotely, confirmed. Wait
for me before Stage 3.
```

**Acceptance checks:**
- [ ] All 11 tables present with FKs/indexes, locally, including the new `incident_events`
- [ ] Migrations are in `workers/core-api/migrations/`, not `packages/core-api/migrations/`
- [ ] Same confirmed on remote production D1
- [ ] `deleted_at` soft-delete columns present on `incidents` and `knowledge_sources`
- [ ] `schema.md` maps every mandatory requirement to a table

**Commit message:** `feat(db): D1 schema and migration (with soft-delete support), applied locally and to remote production`

---

## Stage 3 — Durable Object: Incident Room State Machine — Deploy & Verify

```
STAGE 3 — DURABLE OBJECT STATE MACHINE (NO AI YET, LOCAL + PRODUCTION)

OBJECTIVES:
- Implement the IncidentRoom state machine exactly per
  00-architecture-and-contracts.md §4, including the new Validated state,
  crash-recovery consideration, concurrency handling, and version numbers.

SUCCESS CRITERIA:
- All legal transitions in §4.1 work; all others are rejected.
- Two concurrent review-approval requests resolve to exactly one success
  (this specific test is required now even though HITL review logic itself
  isn't built until Stage 14 — you can test this against a simplified
  same-shape transition attempt using existing states, then re-verify for
  real once /review exists).
- Both proven locally AND against deployed production.

DELIVERABLES:
- IncidentRoom DO class in core-api, with version field, in
  core-api/wrangler.jsonc DO binding + migration entry.

CONSTRAINTS:
- Zero AI/LLM calls this stage.
- Zero D1 access this stage.
- State transition checking must be an explicit allow-list of exact
  from→to pairs (§4.2), not a deny-list.

Read 00-architecture-and-contracts.md §4 in full before starting — it
specifies the exact state machine (now including `Validated`), illegal
transition handling, crash recovery expectations, concurrency/locking
reasoning, and the version-number requirement. Implement to that spec.

REQUIREMENTS:
1. One DO class, keyed by idFromName(incident_id) — verify current API.
2. DO storage: current state, a `version` integer incremented on every
   successful transition (§4.6), raw ingested data, placeholder slots for
   timeline/root_cause/prevention/report (filled later by core-api based on
   agent RPC responses).
3. Transition method rejects invalid jumps per the §4.2 allow-list, with a
   clear error.
4. Prove it manually: walk a fake incident through every legal transition
   in §4.1 (including the new Validated state and its self-loop-on-
   validation-failure), then attempt at least two different illegal jumps,
   confirm rejection.
5. Prove the concurrency guarantee from §4.4: fire two concurrent requests
   attempting the same transition from the same state, confirm exactly one
   succeeds — this relies on the DO's serial-execution guarantee, verify
   that's still accurate for the current Durable Objects API before relying
   on it.
6. Update wrangler.jsonc with the DO binding + correct migration entry.
7. Deploy to production, re-run the SAME walk-through and concurrency test
   against the deployed core-api.

STOP after both local and production tests (including the concurrency
proof) pass. Wait for me before Stage 4.
```

**Acceptance checks:**
- [ ] All legal transitions from §4.1 work, including `Validated`'s self-loop behavior
- [ ] Illegal jumps rejected with clear errors
- [ ] Concurrency test: two simultaneous same-transition requests → exactly one succeeds — verified locally AND in production
- [ ] `version` field increments correctly on every transition
- [ ] No D1 code touched

**Commit message:** `feat(do): Incident Room durable object state machine with version tracking and concurrency guarantees, verified locally and in production`

---

## Stage 4 — Core Ingestion API (Idempotent, API-First Contract)

```
STAGE 4 — CORE INGESTION API (IDEMPOTENT, API-FIRST)

OBJECTIVES:
- Implement the first real endpoints exactly per the API Design Reference
  in 00-architecture-and-contracts.md §9 (POST /incidents, POST
  /incidents/{id}/events, GET /incidents/{id}, GET /incidents/{id}/report).

SUCCESS CRITERIA:
- Smoke test (including an idempotency test) passes locally and in
  production.
- Every response follows the {data}/{error} envelope exactly, from this
  stage forward, with no exceptions in later stages.

DELIVERABLES:
- core-api's ingestion module + smoke-test script.

CONSTRAINTS:
- Ingestion logic lives inside core-api (per Stage 0's confirmed decision),
  in a clearly named internal module.
- Idempotency on POST /incidents/{id}/events is required, not optional.

Read 00-architecture-and-contracts.md §9 before starting — implement these
four endpoints to that exact contract (request/response shape, validation,
error cases, auth requirement even though auth enforcement itself isn't
built until Stage 17 — for now just structure the code so adding the auth
check later is a clean insertion, not a rewrite).

REQUIREMENTS:
- STORAGE TARGET (a genuine gap in an earlier draft of this spec, caught and
  fixed after Stage 0 review — read this carefully): `POST
  /incidents/{id}/events` writes each raw submitted event into the new
  `incident_events` table (dual-written alongside the DO's working state) —
  NOT into `timeline_entries`. `timeline_entries` is reserved exclusively
  for TimelineAgent's later processed, ordered output (Stage 7). Conflating
  the two was an error in an earlier version of this plan; keep them
  separate.
- IDEMPOTENCY: POST /incidents/{id}/events accepts an optional
  client-supplied idempotency key (or derives one from a timestamp+detail
  hash) so a retried request doesn't create a duplicate. Document the exact
  mechanism.
- Every meaningful write inserts an agent_activity_logs row (agent_name =
  "IngestionAgent"), including the request_id and DO version per the
  observability spec in 04-quality-ops-security.md §2 — set this pattern up
  now, every later agent will follow it.
- Validate request bodies, clear 400s using the {error: {code, message}}
  shape from the architecture doc's API reference.
- Enable CORS.
- Smoke-test script exercising all four endpoints, INCLUDING calling POST
  /incidents/{id}/events twice with the same idempotency key and confirming
  only one entry was created.
- Deploy to production, re-run the smoke test (including idempotency)
  against the deployed core-api.

STOP after the smoke test passes both locally and in production. Wait for
me before Stage 5.
```

**Acceptance checks:**
- [ ] All four endpoints follow the exact response envelope from the architecture doc
- [ ] Idempotency test passes — retried event submission does not duplicate
- [ ] Passes locally AND against deployed production
- [ ] `agent_activity_logs` rows include `request_id` and DO `version`

**Commit message:** `feat(api): idempotent, versioned incident ingestion endpoints per API reference, deployed and verified`

---

## Stage 5 — AI Gateway + LLM Utility (Shared Package) — Gemini Primary

```
STAGE 5 — LLM UTILITY VIA AI GATEWAY (GEMINI PRIMARY, OPENROUTER FALLBACK)

OBJECTIVES:
- One shared, testable LLM-calling module per the LLM Strategy in
  00-architecture-and-contracts.md §7 — Gemini as PRIMARY provider,
  OpenRouter free-models pool as FALLBACK (note: this order is flipped from
  an earlier version of this plan if you have any memory of a prior draft —
  Gemini is primary now).

SUCCESS CRITERIA:
- Real (non-mocked) response proven locally and through the full
  production Service Binding chain via timeline-agent.
- Fallback to OpenRouter proven by deliberately breaking the Gemini key.

DELIVERABLES:
- /packages/shared/src/llm/callLLM.ts, production secrets set for
  timeline-agent.

CONSTRAINTS:
- Every call goes through an AI Gateway endpoint, never a provider
  directly.
- Enforce maxTokens as a real limit (§7).
- No agent business logic yet — LLM plumbing only.

Read 00-architecture-and-contracts.md §7 before starting — it specifies
provider order, timeout/retry policy, temperature guidance, max-token
enforcement, and structured-output expectations. Implement to that spec.

REQUIREMENTS:
- `callLLM({ systemPrompt, userPrompt, maxTokens, temperature? }) ->
  Promise<{ text, provider, raw }>`.
- VERIFY BEFORE BUILDING: Cloudflare AI Gateway's fallback/routing
  mechanism (Universal Endpoint vs newer Dynamic Routing) — fetch current
  docs rather than assume. If gateway-level fallback is unclear,
  application-level fallback (try Gemini's AI Gateway endpoint, catch
  failure, call OpenRouter's) is acceptable — tell me which you used.
- Secrets from Wrangler secrets/env bindings, never hardcoded/logged, in
  ANY of the five worker projects.
- On total failure (both providers), typed error, no unhandled throw.
- Temporary debug RPC method on timeline-agent: "Reply with the single
  word: pong" — proves the shared package imports correctly cross-worker
  too.
- Set production secrets for timeline-agent (GEMINI_API_KEY,
  OPENROUTER_API_KEY), deploy it and core-api, hit the debug method through
  the production Service Binding.

Do not build agent logic yet. If you cannot get real free-tier access
working for either provider, STOP and tell me exactly what's blocking — do
not silently mock.

STOP after the debug method returns a real response both locally and in
production, and the Gemini→OpenRouter fallback is proven. Wait for me
before Stage 6.
```

**Acceptance checks:**
- [ ] Real, non-mocked response locally, using Gemini as the serving provider under normal conditions
- [ ] Same proof works through the deployed production Service Binding
- [ ] Breaking the Gemini key temporarily → real OpenRouter fallback response; key restored after
- [ ] AI Gateway dashboard shows the requests
- [ ] No key in any committed file or log output

**Commit message:** `feat(llm): shared AI Gateway utility (Gemini primary, OpenRouter fallback), proven working in production via timeline-agent`

---

## Stage 6 — Agents SDK: Wiring Each Agent Worker — Deploy & Verify

```
STAGE 6 — AGENTS SDK ACROSS THE FOUR AGENT WORKERS (LOCAL + PRODUCTION)

OBJECTIVES:
- Agents SDK correctly configured in all four agent workers, matching each
  agent's contract in 00-architecture-and-contracts.md §3 for input/output
  typing (real logic still comes in later stages — this is scaffolding).

SUCCESS CRITERIA:
- Full round-trip (core-api → timeline-agent Agent class → callLLM → real
  response → back) proven locally AND in production.

DELIVERABLES:
- Agents SDK configured in all four agent worker projects; typed
  input/output interfaces matching §3's contracts exactly.

CONSTRAINTS:
- Agent workers never import each other, never call each other — confirmed
  by inspecting each project's dependencies.
- Typed interfaces must match the Agent Contracts table exactly (§3 of the
  architecture doc), not an ad hoc shape.

VERIFY CURRENT DOCS FIRST: the Agents SDK changes fast — package name, base
class, tsconfig decorator requirements, wrangler config shape. Confirm
fresh against developers.cloudflare.com/agents.

WHAT TO BUILD:
1. Install/configure the Agents SDK in EACH of the four agent workers.
2. Define the TypeScript input/output types for each agent to exactly match
   00-architecture-and-contracts.md §3.1 (TimelineAgent), §3.3
   (RootCauseAgent), §3.4 (PreventionAgent), §3.5 (ModeratorAgent) — even
   though only timeline-agent gets real logic this stage, define all four
   types now so nothing drifts later.
3. In timeline-agent: convert the placeholder RPC method into a real
   Agent-SDK-based class, confirm it calls the shared callLLM utility.
   Prove the "pong" round-trip again through this structure.
4. The other three agent workers get the same scaffolding but can remain
   placeholder/no-op at the SDK level this stage.
5. Confirm (at least in timeline-agent) the Agents SDK's tool-calling
   mechanism is wired with one placeholder no-op tool — real tool-calling
   (StatusCorrelator, §8.2 of the architecture doc) starts in Stage 10.
6. Deploy all four agent workers + core-api, re-run the "pong" round-trip
   against the FULL production deployment — this is the second most
   important remote-verification checkpoint in the project.

STOP after the proof works in both environments and all four workers have
consistent, correctly-typed scaffolding. Wait for me before Stage 7.
```

**Acceptance checks:**
- [ ] Agents SDK correctly configured in all four projects
- [ ] Round-trip works locally
- [ ] Same round-trip works in production
- [ ] Each agent worker's input/output types match its Agent Contract in the architecture doc exactly
- [ ] No agent worker imports or references another agent worker

**Commit message:** `feat(agents): Cloudflare Agents SDK wired into all four agent workers with contract-matched types, verified in production`

---

## Stage 7 — Timeline Agent (Real Logic)

```
STAGE 7 — TIMELINE AGENT: REAL LOGIC

OBJECTIVES:
- Implement TimelineAgent exactly per its contract in
  00-architecture-and-contracts.md §3.1.

SUCCESS CRITERIA:
- Both a messy and a clean test incident produce plausible, readable
  output, matching the exact output shape in §3.1's example.

DELIVERABLES:
- Real logic in timeline-agent's Agent class.

CONSTRAINTS:
- Exact RPC input/output shape from §3.1 — no ad hoc fields.
- Failure handling per §3.1's Failure/Retry/Timeout rows — core-api must
  not advance state on failure.

Read 00-architecture-and-contracts.md §3.1 before starting — implement to
that exact contract.

RECOMMENDED SEQUENCING: build a deterministic placeholder (plain
sort-by-timestamp, no LLM) first, prove the RPC-in/RPC-out and core-api
state-advancement mechanics work, THEN swap in the real LLM version. Skip
this only if you're confident and tell me why.

REQUIREMENTS:
- Input/output exactly per §3.1. core-api builds the `raw_events` RPC input
  by reading all rows from `incident_events` for this incident (not
  `timeline_entries`, which doesn't exist yet at this point in the
  pipeline).
- core-api persists the timeline into DO + D1 timeline_entries, advances
  Ingested -> TimelineDone, logs to agent_activity_logs — but does NOT yet
  advance further (Validation Gate, Stage 8, gates the next step).
- Failure -> incident stays in Ingested, per §3.1.
- Trigger: POST /incidents/{id}/analyze calls timeline-agent if incident is
  in Ingested (full auto-chain including Validation comes in Stage 13).
- Test with one messy incident (out-of-order, one missing timestamp) and
  one clean incident, through the real RPC path — show me both.

STOP after both outputs look genuinely sensible. Wait for me before
Stage 8.
```

**Acceptance checks:**
- [ ] Output shape matches §3.1's contract exactly
- [ ] Both test outputs are plausible — you read them
- [ ] State advances Ingested → TimelineDone only on success
- [ ] Failure leaves incident in Ingested

**Commit message:** `feat(agent): timeline-agent produces real ordered timelines per its contract, via Service Binding RPC`

---

## Stage 8 — Validation Gate (NEW — Deterministic, No LLM)

```
STAGE 8 — VALIDATION GATE (DETERMINISTIC, LIVES IN CORE-API)

OBJECTIVES:
- Implement the Validation Gate exactly per
  00-architecture-and-contracts.md §3.2 — a deterministic check that runs
  automatically after TimelineAgent completes, before RootCauseAgent is
  ever triggered, catching bad timelines before expensive LLM reasoning
  builds on top of them.

SUCCESS CRITERIA:
- A deliberately bad timeline (missing timestamps, too few events,
  contradictory near-duplicate events) is correctly flagged invalid, and
  the incident stays in TimelineDone rather than advancing.
- A good timeline is correctly validated and the incident advances to the
  new Validated state.
- POST /incidents/{id}/events remains callable while an incident is
  "stuck" in TimelineDone due to failed validation, so more data can be
  added and analysis re-triggered.

DELIVERABLES:
- A validation module inside core-api (NOT a new Worker — read §3.2 for why
  this specific piece of logic doesn't get its own deployable Worker even
  though every other analysis step does).
- New `Validated` state wired into the IncidentRoom state machine's
  allow-list from Stage 3.

CONSTRAINTS:
- No LLM call anywhere in this stage.
- No new Worker project — this is core-api-internal logic.
- Do not over-engineer "contradictory events" detection into an NLP
  problem — a shallow, explainable check (e.g. near-duplicate timestamps
  with conflicting descriptions) is the right scope here, per the honest
  assessment in 00-architecture-and-contracts.md's Appendix.

Read 00-architecture-and-contracts.md §3.2 before starting — it specifies
the exact checks to perform, the exact output shape, and exactly how
core-api should react to a valid vs invalid result.

REQUIREMENTS:
1. Implement the checks from §3.2: event count below a minimum threshold,
   missing-timestamp ratio above a threshold, contradictory near-duplicate
   events, suspiciously large unexplained gaps. Make thresholds named
   constants, not magic numbers.
2. On invalid: incident stays in TimelineDone, a `validation_status` flag
   is set, a human-readable issues summary is written to `conversations`
   (author='agent'), and an agent_activity_logs row (agent_name =
   "ValidationGate") is written. Auto-chaining (once it exists in Stage 13)
   must stop here, not push forward.
3. On valid: state advances TimelineDone -> Validated (add this transition
   to the Stage 3 state machine's allow-list now), logged the same way.
4. Update the state-machine allow-list from Stage 3 to include Validated
   and its transitions — this touches Stage 3's code, that's expected and
   fine.
5. Test BOTH paths explicitly with real (fake) data: one timeline that
   should fail validation, one that should pass. Show me both outcomes,
   including what happens when you then call POST /incidents/{id}/events
   again on the failed one and re-trigger analysis.
6. Deploy to production, re-verify both paths against the deployed core-api.

STOP after both paths are proven, locally and in production. Wait for me
before Stage 9.
```

**Acceptance checks:**
- [ ] Invalid timeline correctly flagged, incident stays in `TimelineDone`, issues summary written to `conversations`
- [ ] Valid timeline correctly advances to the new `Validated` state
- [ ] Adding more events and re-triggering analysis after a validation failure works end to end
- [ ] Verified in production, not just locally
- [ ] No LLM call anywhere in this stage's code path

**Commit message:** `feat(validation): deterministic Validation Gate between Timeline and RootCause, closing the garbage-in-garbage-out risk`

---

## Stage 9 — RAG Knowledge Base: Ingestion & Retrieval Pipeline

```
STAGE 9 — RAG PIPELINE: INGESTION + EMBEDDINGS + RETRIEVAL

OBJECTIVES:
- Implement the RAG pipeline exactly per
  00-architecture-and-contracts.md §6 — chunking, embedding, storage,
  retrieval, with the interface shaped so re-ranking could be added later
  without a rewrite (§6.6), even though re-ranking itself isn't built now.

SUCCESS CRITERIA:
- Two required proofs (different-queries-return-different-results, and
  delete-a-document-changes-retrieval-results) both pass.

DELIVERABLES:
- Ingestion + retrieveRelevantKnowledge() inside core-api.

CONSTRAINTS:
- Lives in core-api only (needs D1) — rootcause-agent and prevention-agent
  never query D1 or retrieve themselves; core-api passes results in as RPC
  arguments.
- Use the soft-delete pattern (deleted_at) from Stage 2 for the
  delete-a-document proof, so it's easily reversible.

Read 00-architecture-and-contracts.md §6 before starting — it specifies
sources, chunking approach, metadata, embedding model guidance, retrieval
strategy/top-k, and citation requirements. Implement to that spec.

REQUIREMENTS:
- Seed data: 3-5 runbook documents, 2-3 fake past-incident write-ups, per §6.1.
- Chunking/embedding/storage per §6.2-§6.4.
- retrieveRelevantKnowledge(query, k=3) per §6.5.
- TWO REQUIRED PROOFS:
  A. Two different queries return different, topically appropriate results.
  B. Soft-deleting one specific document, re-running the same query that
     used to match it, shows retrieval results change — then restore it
     (set deleted_at back to null).

Do not wire into rootcause-agent yet — Stage 10.

STOP after both proofs pass. Wait for me before Stage 10.
```

**Acceptance checks:**
- [ ] Proof A: different queries, different appropriate results
- [ ] Proof B: soft-deleting a document changes retrieval for a query that used to match it; document restored after
- [ ] Embedding calls visible in AI Gateway dashboard
- [ ] Retrieval logic lives only in core-api

**Commit message:** `feat(rag): knowledge base ingestion, embeddings, and similarity retrieval per RAG spec, proven corpus-dependent`

---

## Stage 10 — Root-Cause Agent (RAG-Powered, Real Tool Calling)

```
STAGE 10 — ROOTCAUSE-AGENT: RAG + REAL TOOL CALLING

OBJECTIVES:
- Implement RootCauseAgent exactly per its contract in
  00-architecture-and-contracts.md §3.3, and the StatusCorrelator tool per
  §8.2.

SUCCESS CRITERIA:
- The two critical proofs (RAG-influences-generation, tool-gets-invoked-by-
  model-decision) both pass, with real output shown.

DELIVERABLES:
- Real logic in rootcause-agent, StatusCorrelator tool wired via Agents SDK
  tool-calling.

CONSTRAINTS:
- Exact I/O shape from §3.3 — cannot fabricate a citation to a chunk that
  wasn't actually provided.
- Tool invocation must be genuinely LLM-decided (§8.2), not an unconditional
  pre-call.
- rootcause-agent never touches D1 — retrieval is core-api's job, passed in
  as an RPC argument.

Read 00-architecture-and-contracts.md §3.3 and §8.2 before starting.

REQUIREMENTS:
1. Input: timeline + retrieved_context (from core-api, using Stage 9's
   retrieval with the timeline as the query) per §3.3.
2. RAG-grounded prompt: reference material clearly labeled, instructed to
   flag extrapolation beyond it.
3. StatusCorrelator tool per §8.2: real, public, no-key status-page JSON
   endpoints (verify current real URLs before hardcoding), the model
   decides whether to invoke it, graceful failure handling (returns
   "unknown", doesn't crash).
4. Output exactly per §3.3's shape, including tool_invocations and
   needs_review (confidence < the named CONFIDENCE_THRESHOLD constant,
   default 0.5).
5. core-api persists per the contract, advances Validated -> RootCauseDone
   (only from Validated — note this is different from the old
   TimelineDone -> RootCauseDone transition, since Validation Gate now sits
   between them).

CRITICAL PROOF 1 (single most important RAG test in the project): same
incident, twice — once with the supporting chunk present, once soft-deleted
— show cause/confidence/citation visibly differ.
CRITICAL PROOF 2: an incident implying a third-party dependency issue
triggers real tool invocation, visible in logs, reflected in evidence.

STOP only after both proofs pass with real shown output. Wait for me before
Stage 11.
```

**Acceptance checks:**
- [ ] Output matches §3.3's exact contract shape
- [ ] Proof 1 (RAG-influences-generation) passes, verified by you personally
- [ ] Proof 2 (real LLM-decided tool invocation) passes
- [ ] Tool failure handled gracefully
- [ ] State advances only from `Validated`, not directly from `TimelineDone`

**Commit message:** `feat(agent): rootcause-agent with RAG-grounded analysis and real LLM-driven external tool calling, per contract`

---

## Stage 11 — Prevention Agent

```
STAGE 11 — PREVENTION-AGENT

OBJECTIVES:
- Implement PreventionAgent exactly per
  00-architecture-and-contracts.md §3.4.

SUCCESS CRITERIA:
- Recommendations are specific to the actual root cause, honestly cited or
  honestly null, matching §3.4's example shape.

DELIVERABLES:
- Real logic in prevention-agent.

CONSTRAINTS:
- No D1 access, no fabricated citations (§3.4).

Read 00-architecture-and-contracts.md §3.4 before starting.

REQUIREMENTS:
- Input: root cause + evidence + fresh retrieval (query = root cause text)
  from core-api, per §3.4.
- Output: array of { recommendation, reference: string|null }.
- core-api persists, advances RootCauseDone -> PreventionDone.
- Show me output for the same test incident from Stage 10 — read it
  critically: specific to this cause, or generic boilerplate?

STOP after you've reviewed real, specific output. Wait for me before
Stage 12.
```

**Acceptance checks:**
- [ ] Output matches §3.4's contract shape
- [ ] Recommendations specific to the actual root cause, not generic
- [ ] At least one real citation; nulls are honest
- [ ] State advances correctly

**Commit message:** `feat(agent): prevention-agent with grounded, cited recommendations, per contract`

---

## Stage 12 — Moderator Agent

```
STAGE 12 — MODERATOR-AGENT

OBJECTIVES:
- Implement ModeratorAgent exactly per
  00-architecture-and-contracts.md §3.5.

SUCCESS CRITERIA:
- A single coherent draft report assembled from all prior outputs,
  retrievable via GET /incidents/{id}/report.

DELIVERABLES:
- Real logic in moderator-agent; enriched GET /report response.

CONSTRAINTS:
- No retrieved knowledge needed (unlike Timeline/RootCause/Prevention).
- The optional narrative-summary LLM call must not alter the underlying
  structured data — narrate only (§3.5). If it fails, fall back to a
  template-assembled summary rather than failing the stage.

Read 00-architecture-and-contracts.md §3.5 before starting.

REQUIREMENTS:
- Input: timeline, root cause + evidence, recommendations, per §3.5.
- Output matches §3.5's shape.
- core-api persists, advances PreventionDone -> AwaitReview.
- GET /incidents/{id}/report now returns the full assembled draft once
  AwaitReview is reached.
- Show me one incident's full assembled report — does it read coherently
  end to end?

STOP after a coherent draft is produced and readable via GET /report. Wait
for me before Stage 13.
```

**Acceptance checks:**
- [ ] Output matches §3.5's contract shape
- [ ] Report reads coherently, not as four disconnected chunks
- [ ] `GET /report` returns the full draft once `AwaitReview` is reached

**Commit message:** `feat(agent): moderator-agent assembles final draft report, per contract`

---

## Stage 13 — Full Pipeline Auto-Orchestration (Including Validation) — Deploy & Verify

```
STAGE 13 — AUTO-CHAINING ACROSS ALL STAGES (LOCAL + PRODUCTION)

OBJECTIVES:
- One trigger runs the complete chain: timeline-agent -> Validation Gate ->
  rootcause-agent -> prevention-agent -> moderator-agent, automatically,
  with core-api orchestrating and persisting after every hop.

SUCCESS CRITERIA:
- One `POST /incidents/{id}/analyze` call, followed by polling GET /report,
  reaches AwaitReview with no further manual intervention, locally AND in
  production.
- A validation failure correctly halts the chain at TimelineDone (does not
  silently skip to RootCause).
- An agent failure anywhere else correctly halts the chain at its last
  successful state.

DELIVERABLES:
- Orchestration logic in core-api implementing the full sequence.

CONSTRAINTS:
- core-api remains the only component that knows this sequence exists —
  none of the four agent workers or the Validation Gate know what runs
  before or after them (Architecture Principle §1.8-1.9).

REQUIREMENTS:
- Chain: timeline-agent RPC -> (on success) Validation Gate (deterministic,
  in-process) -> (if valid) rootcause-agent RPC -> (on success)
  prevention-agent RPC -> (on success) moderator-agent RPC -> AwaitReview.
- ANY failure (agent RPC failure OR validation failure) stops the chain at
  the last successfully-reached state — no skipping forward.
- Decide (tell me the tradeoff) whether core-api awaits each call
  synchronously within one request handler, or uses the DO's alarm/
  scheduling mechanism for async execution — check current Workers
  execution-time limits before deciding, four sequential LLM + tool calls
  can be slow.
- GET /report reflects real incremental progress if polled mid-chain.
- Test: one trigger, poll to AwaitReview, no manual per-agent calls.
- Deploy the whole system to production (first time all pieces are
  non-stub and run together) and re-run the identical full-chain test live.

STOP after one full automatic run works in both environments, and you've
explained the orchestration mechanism choice. Wait for me before Stage 14.
```

**Acceptance checks:**
- [ ] One trigger runs the entire chain (including Validation) to completion locally
- [ ] Same full chain works in production
- [ ] A validation failure halts at `TimelineDone`, doesn't skip forward
- [ ] Breaking one agent mid-chain halts correctly
- [ ] `GET /report` shows real incremental progress mid-chain

**Commit message:** `feat(pipeline): automatic end-to-end orchestration including Validation Gate, verified in production`

---

## Stage 14 — Human-in-the-Loop Review (Structurally Enforced)

```
STAGE 14 — HUMAN-IN-THE-LOOP REVIEW (STRUCTURALLY ENFORCED)

OBJECTIVES:
- Implement POST /incidents/{id}/review exactly per
  00-architecture-and-contracts.md §9, with the anti-bypass and concurrency
  guarantees from §4.4 fully exercised for real this time (Stage 3 tested
  the DO mechanism abstractly; this stage proves it end to end with real
  review logic).

SUCCESS CRITERIA:
- All three paths (approve / reject / modify) work correctly.
- Reviewing outside AwaitReview is rejected.
- Two concurrent approval requests on the same incident resolve to exactly
  one success — the real version of Stage 3's abstract test.

DELIVERABLES:
- Review endpoint + handler in core-api.

CONSTRAINTS:
- No agent worker involved this stage.
- Nothing reaches Finalized without a `reviews` row — no exceptions, no
  internal shortcuts.

Read 00-architecture-and-contracts.md §9 (API reference) and §4.4
(concurrency) before starting.

REQUIREMENTS:
1. REJECT (409) any review attempt on an incident not in AwaitReview.
2. approved=true (clean): reviews row, conversations row, AwaitReview ->
   Finalized, "Verified by {reviewer} on {date}" in the stored report.
3. approved=false: reviews row (reject), loop-back per `modifications`
   target (TimelineDone/RootCauseDone/PreventionDone), default
   RootCauseDone if unspecified. Note: rejecting back to TimelineDone means
   the next analyze call will re-run Validation too, which is correct
   behavior, not a bug.
4. approved=true with modifications: apply edits before finalizing, note as
   modified approval.
5. Log every review action to agent_activity_logs.
6. Test all three paths, and re-run the REAL two-concurrent-requests test
   from Stage 3 against actual /review calls this time.

STOP after all paths and the anti-bypass + concurrency checks are verified
in both environments. Wait for me before Stage 15.
```

**Acceptance checks:**
- [ ] Reviewing outside `AwaitReview` rejected, locally and in production — you tried this yourself
- [ ] All three paths (approve/reject/modify) produce correct D1 state
- [ ] Two concurrent approval requests → exactly one succeeds, verified for real against `/review`
- [ ] No path reaches `Finalized` without a `reviews` row

**Commit message:** `feat(hitl): enforced human review gate with real concurrency proof, verified in production`

---

## Stage 15 — Persistent Memory & Cross-Incident Learning

```
STAGE 15 — PERSISTENT MEMORY & "HAVE WE SEEN THIS BEFORE"

OBJECTIVES:
- Cross-incident semantic search and per-user preference memory, both
  reusing existing infrastructure rather than duplicating it.

SUCCESS CRITERIA:
- /incidents/similar returns sensible ranked matches.
- Per-user confidence threshold override provably changes RootCauseAgent
  behavior for a borderline case.

DELIVERABLES:
- GET /incidents/similar endpoint; user_preferences storage.

CONSTRAINTS:
- Reuses Stage 9's retrieval pipeline — no parallel implementation.
- Threshold override passed into rootcause-agent as an RPC argument (per
  its contract's confidence_threshold_override field, §3.3) — never
  hardcoded in the agent itself.

REQUIREMENTS:
- Feature A: GET /incidents/similar?query= searches FINALIZED past
  incidents (embedded/stored like knowledge_sources, tagged
  type='past_incident' per §6.1).
- Feature B: user_preferences (JSON column or child table on users) with a
  default confidence threshold override + default reviewer name. Prove it
  changes a borderline case's needs_review outcome.

STOP after both features are proven. Wait for me before Stage 16.
```

**Acceptance checks:**
- [ ] `/incidents/similar` returns sensible, ranked results
- [ ] Finalized incidents become searchable, tagged correctly
- [ ] Per-user threshold override changes a borderline case's outcome, passed via RPC argument

**Commit message:** `feat(memory): cross-incident semantic search + per-user preference memory`

---

## Stage 16 — React Frontend (Thin, Minimal, API-First Demo Client)

```
STAGE 16 — REACT FRONTEND (STAY THIN)

OBJECTIVES:
- Implement exactly the frontend described in
  00-architecture-and-contracts.md §10 — uploads, review, visualization,
  status, zero business logic.

SUCCESS CRITERIA:
- Full flow completable using only the UI.
- Nothing beyond the five listed pages exists.

DELIVERABLES:
- /client fully built out.

CONSTRAINTS:
- Zero business logic in the frontend — every rule is enforced by core-api;
  the frontend only reflects it (§10). If you catch yourself implementing a
  validation rule, confidence check, or state-transition rule IN React,
  stop — that belongs in core-api and should already exist there.
- Exactly five pages, no more, per the list below.

Read 00-architecture-and-contracts.md §10 before starting.

PAGES (complete list, not a starting point):
1. Incident Submission, 2. Timeline Entry, 3. Review Dashboard (with
   visually distinct AI-suggested vs human-decided content), 4. Report
   View, 5. (optional) similar-incidents search box.

REQUIREMENTS: one API client module, env-var base URL, surfaced API errors,
loading states for slow LLM-backed operations, no hardcoded sample data, no
routing/state/component library additions without asking.

STOP after the full flow works via UI only, and nothing beyond the five
pages was built. Wait for me before Stage 17.
```

**Acceptance checks:**
- [ ] Full flow works via UI only
- [ ] API errors surfaced, loading states present
- [ ] No hardcoded sample data
- [ ] Frontend genuinely stayed thin — spot-checked against the five-page list
- [ ] No business logic duplicated from core-api into React

**Commit message:** `feat(frontend): minimal React demo client per frontend philosophy — uploads, review, visualization, status only`

---

## Stage 17 — Auth & Security

```
STAGE 17 — AUTH & SECURITY

OBJECTIVES:
- Implement authentication and the security controls specified in
  04-quality-ops-security.md §3.

SUCCESS CRITERIA:
- Unauthenticated mutating requests rejected; authenticated ones succeed,
  locally and in production.
- Every item in the Security Spec table (§3) is either implemented or
  explicitly documented as a scoped-out roadmap item in SECURITY.md — not
  silently ignored.

DELIVERABLES:
- Auth middleware in core-api; SECURITY.md.

CONSTRAINTS:
- Auth check happens before any D1/DO work, not after.
- None of the four agent workers may expose a public route bypassing
  core-api's auth.

Read 04-quality-ops-security.md §3 before starting — it covers prompt
injection, RAG poisoning, secret management, rate limiting, input
validation, output sanitization, auth/authz, and replay attacks, with what's
in-scope to build now vs. documented as future work.

REQUIREMENTS:
- Bearer token auth against `users` on every mutating core-api endpoint.
- CORS restricted to real frontend origin(s) in production, permissive
  localhost for dev only.
- Audit all five worker codebases for accidental secret logging.
- SECURITY.md covering every row of §3's table — what's built, what's
  explicitly deferred and why.
- Test unauthenticated-rejected / authenticated-succeeds, locally and in
  production.

STOP after both are verified in both environments. Wait for me before
Stage 18.
```

**Acceptance checks:**
- [ ] Unauthenticated mutating request → 401, locally and in production
- [ ] Authenticated request succeeds
- [ ] No agent worker exposes a bypass route
- [ ] `SECURITY.md` addresses every item in the Security Spec table

**Commit message:** `feat(security): API token auth, CORS hardening, and full security-spec coverage in SECURITY.md`

---

## Stage 18 — Observability & Structured Logging

```
STAGE 18 — OBSERVABILITY ACROSS FIVE WORKERS

OBJECTIVES:
- Implement the logging shape and ID scheme from
  04-quality-ops-security.md §2 consistently across all five workers.

SUCCESS CRITERIA:
- One incident_id's full story is reconstructable across all five workers
  in the production dashboard, using request_id and DO version to
  disambiguate concurrent activity.

DELIVERABLES:
- Standardized logging across all five projects; OBSERVABILITY.md.

Read 04-quality-ops-security.md §2 before starting — it specifies the exact
log shape (including request_id and DO version, which should already exist
from Stages 3-4) and what to track (latency, retries, failures per agent).

REQUIREMENTS:
- Refactor existing logs in all five projects to the shape in §2.2.
- Verify current Cloudflare Workers observability product behavior for
  filtering by incident_id across multiple workers.
- Confirm AI Gateway analytics show real data.
- OBSERVABILITY.md with a working example query, run against production.

STOP after this is done. Wait for me before Stage 19.
```

**Acceptance checks:**
- [ ] Log shape consistent across all five projects, including `request_id` and `version`
- [ ] One incident traced across multiple workers in the production dashboard
- [ ] AI Gateway analytics show real data
- [ ] `OBSERVABILITY.md` has a working example

**Commit message:** `chore(observability): standardized structured logging with correlation IDs across all workers`

---

## Stage 19 — Automated Testing

```
STAGE 19 — AUTOMATED TESTING

OBJECTIVES:
- Cover every category in 04-quality-ops-security.md §1's Testing Taxonomy
  that applies to an automated suite (Unit, Integration, Worker RPC,
  Durable Object, RAG, Golden Incident, Regression, Failure injection —
  Load is explicitly out of scope, Manual/Acceptance are the human
  checklists you've been running all along).

SUCCESS CRITERIA:
- Clean pass locally and against production for every applicable category.

DELIVERABLES:
- Automated test suite.

Read 04-quality-ops-security.md §1 before starting — implement each
applicable category to the pass criteria specified there, including the
concurrency test from Stage 3/14 as an explicit DO-category test, and the
Validation Gate's invalid/valid paths as explicit test cases.

REQUIREMENTS: (as previously specified — golden incidents by category not
exact string, automated RAG-influence proof, automated HITL anti-bypass +
concurrency proof, automated auth checks, automated multi-worker
chain-failure-halts-correctly check, PLUS now: automated Validation Gate
valid/invalid path checks.) Don't weaken an assertion to make it pass — fix
the real issue, tell me if you're tempted to cut a corner.

STOP after a clean pass in both environments. Wait for me before Stage 20.
```

**Acceptance checks:**
- [ ] Every applicable Testing Taxonomy category (§1 of the quality doc) represented
- [ ] Clean pass locally and against production
- [ ] Nothing weakened just to pass

**Commit message:** `test: automated suite per the full Testing Taxonomy, covering Validation Gate, RAG, HITL, concurrency, and chain integrity`

---

## Stage 20 — CI/CD Automation & Final Deployment Hardening

```
STAGE 20 — CI/CD AUTOMATION (NOT A FIRST DEPLOYMENT)

OBJECTIVES:
- Automate the deployment process that's been proven manually since
  Stage 1.

SUCCESS CRITERIA:
- GitHub Actions deploys all five workers in dependency order plus the
  frontend, on a successful test run, and you've personally re-verified the
  live flow one final time.

By now core-api and all four agent workers have been deployed and
re-verified in production repeatedly (Stages 1, 2, 3, 5, 6, 8, 13, 14, 17,
18). This stage automates that, and does one final hardening pass — it is
explicitly not a first-time deployment.

REQUIREMENTS: GitHub Actions workflow (test suite -> deploy agent workers ->
deploy core-api -> deploy frontend), Cloudflare API token/account ID as
GitHub secrets, double-check all five workers' production secrets are
independently set, confirm D1 remote migrations are current, final live
end-to-end flow run by you personally.

STOP after CI passes on a test push and the final live flow is verified.
Wait for me before Stage 21.
```

**Acceptance checks:**
- [ ] CI deploys all five workers in correct order, then frontend
- [ ] All production secrets independently confirmed
- [ ] D1 remote migrations current
- [ ] You personally ran the final live flow check
- [ ] No secrets in Actions YAML or git history

**Commit message:** `chore(ci): GitHub Actions automation for the five-worker deployment pipeline`

---

## Stage 21 — Documentation & Demo Prep (Open-Source-Ready README)

```
STAGE 21 — README & DEMO PREP (FINAL STAGE)

OBJECTIVES:
- Produce a README that would hold up as a real open-source project's
  front door, not just a challenge submission's writeup, per the structure
  below.

SUCCESS CRITERIA:
- Every required section present and accurate against the AS-BUILT system
  (which now includes the Validation Gate and the corrected LLM provider
  order — reconcile against the original design doc's simpler sketch
  explicitly, don't silently copy the old plan).

README.md MUST INCLUDE:
1. Product Overview (including the API-first framing).
2. Architecture (all five workers + Validation Gate, Service Bindings,
   Agent SDK usage, RAG, DO usage, HITL workflow) — updated diagram.
3. API Reference (every /api/v1 endpoint, pulled from
   00-architecture-and-contracts.md §9).
4. Deployment (local setup incl. multi-worker dev command, five-worker
   production deploy order, every env var/secret across all five projects).
5. Cloudflare Services (where/why each mandatory service was used, mapped
   to specific files).
6. Testing (what's covered per the Testing Taxonomy, and Load testing's
   explicit out-of-scope status per 04-quality-ops-security.md §1).
7. Roadmap (pull from 05-product-vision-roadmap.md — clearly labeled as
   future/aspirational, not built).
8. Screenshots (of the actual running frontend and a real report).
9. License (pick one — MIT is a reasonable default for this kind of
   project, ask me if you want a different one).
10. Contribution guide (brief — this is a challenge submission, not an
    active open-source project yet, so keep this realistic in scope: how to
    run tests, coding conventions from 04-quality-ops-security.md §4).
11. Live Deployment (actual URLs).

ALSO: a demo script (create incident, add events, trigger, watch the chain
including the Validation Gate execute across multiple workers in the logs,
view draft, approve, view final report — narrate "AI suggested X, human
approved X"), and a requirement-to-file-path mapping for every mandatory
challenge requirement (Agent, RAG, HITL, Tool Calling, Persistent Memory,
Real LLM Integration) plus the Validation Gate as a bonus architectural
strength worth calling out explicitly in the README's own words.

Read through as if you were a grader who's never seen this project. Flag
anything confusing.

STOP. Project complete.
```

**Acceptance checks:**
- [ ] Every section present with exact structure above
- [ ] Architecture diagram matches the actual as-built system, including Validation Gate
- [ ] API Reference section is complete, not just a mention
- [ ] Roadmap section clearly labeled as future/not-built
- [ ] Demo script run through once, live, start to finish

**Commit message:** `docs: final open-source-ready README, API reference, roadmap, demo script, requirement mapping`

---

**You're done.** 22 stages, every mandatory challenge requirement, the
Validation Gate robustness improvement, and a documentation set
(`00-architecture-and-contracts.md`, `04-quality-ops-security.md`,
`05-product-vision-roadmap.md`) that reads like a real product's internal
spec rather than a challenge writeup. Do one final top-down pass against
`cloudf.txt` before submitting.
