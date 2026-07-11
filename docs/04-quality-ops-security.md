# IncidentIQ — Quality, Observability & Security Reference

Companion to `00-architecture-and-contracts.md`. This covers how we verify
the system is correct (testing), how we see what it's doing (observability),
how we protect it (security), and the baseline code quality bar every stage
is held to. Stage 19 (Testing), Stage 18 (Observability), and Stage 17
(Security) in `02-stage-prompts.md` implement what's specified here — those
stage prompts stay relatively short and point back to this document rather
than repeating it.

---

## 1. Testing Taxonomy

Every category below should exist somewhere in the project by the time
Stage 19 is done. Not every category needs to be large — some are a handful
of tests — but all should be represented, with an explicit pass criterion.

| Category | What it covers | Pass criterion |
|---|---|---|
| **Unit** | Pure functions with no network/D1/DO dependency — e.g. the state-transition allow-list check (§4.2 of the architecture doc), the Validation Gate's individual checks, response-envelope formatting | Runs in milliseconds, no external dependency, deterministic pass/fail |
| **Integration** | core-api's internal modules working together against a real (local) D1 + DO — e.g. "create incident, add event, confirm both D1 and DO reflect it" | Runs against local `wrangler dev` D1/DO, no LLM calls needed |
| **Worker RPC** | core-api successfully calling each agent worker via Service Binding and receiving a well-formed response | Runs against local multi-worker `wrangler dev`, can use a real or a stubbed LLM response depending on what's being tested |
| **Durable Object** | State machine correctness: legal transitions succeed, illegal ones are rejected, concurrent review requests resolve to exactly one winner (§4.4 of the architecture doc) | Every transition pair from §4.1 tested explicitly; the concurrency test fires two real concurrent requests and asserts exactly one success |
| **RAG** | Retrieval genuinely depends on corpus contents (Stage 9's Proof A/B), and generation genuinely depends on retrieval (Stage 10's delete-and-rerun test) | Both proofs automated as real repeatable assertions, not just manually eyeballed once |
| **Golden Incident** | End-to-end replays of realistic scripted incidents with known expected outcome CATEGORIES | Structure asserted strictly (fields, types, confidence range); content asserted loosely (category/keyword match, since LLM output isn't perfectly deterministic) |
| **Regression** | Once a real bug is found and fixed at any point in the project, a test is added that would have caught it | Grows organically — don't manufacture artificial regression tests up front, but don't skip adding one when a real bug is fixed either |
| **Load** | Explicitly OUT OF SCOPE for this challenge submission (see Architecture doc Appendix, item 5) — noted here so its absence is a documented decision, not an oversight | N/A — documented as a known gap in the README, not built |
| **Failure injection** | Deliberately breaking a dependency (bad API key, unreachable status-check URL, a D1 write failure) and confirming the system degrades correctly rather than corrupting state or crashing | At minimum: LLM-provider-both-down (Stage 6/7), tool-call failure (Stage 10), one-agent-fails-mid-chain (Stage 13) |
| **Manual** | The human-run checks throughout `03-manual-setup-steps.md` — deliberately not automated because they benefit from a real person's judgment (e.g. "does this output actually read as sensible") | You, the human, actually did them — tracked via the checklists in that file |
| **Acceptance** | The per-stage "Acceptance Checks" lists in `02-stage-prompts.md` | Every box checked before moving to the next stage |

---

## 2. Observability Spec

### 2.1 ID scheme

Every log line and every `agent_activity_logs` row should be traceable using
these identifiers:

- **`incident_id`** — the primary correlation key; almost every log line
  should carry this.
- **`request_id`** — generated fresh by core-api at the top of every
  incoming HTTP request, passed through as an RPC argument to whichever
  agent worker gets called during that request, so a single request's
  footprint across multiple Workers can be reconstructed even though it
  spans process boundaries.
- **`agent_name`** — which component produced this log line
  ("TimelineAgent", "ValidationGate", "RootCauseAgent", "PreventionAgent",
  "ModeratorAgent", "IngestionAgent" for core-api's own ingestion logic,
  "ReviewHandler" for the HITL endpoint).
- **`version`** — the DO's state-machine version number at the time of this
  log line (§4.6 of the architecture doc), for reconstructing exact
  sequencing when debugging.

### 2.2 Structured log shape

```json
{
  "incident_id": "...",
  "request_id": "...",
  "agent_name": "...",
  "version": 3,
  "event": "started | completed | failed",
  "status": "...",
  "detail": "...",
  "timestamp": "..."
}
```
Applied consistently across all five Workers.

### 2.3 What to track

- **Latency** — time from RPC call initiation to response, per agent, so you
  can tell whether a slow pipeline run is timeline-agent being slow vs.
  rootcause-agent's tool call being slow vs. something else.
- **Retries** — every retry attempt (per the Agent Contracts' retry
  behavior) logged as its own event, not silently absorbed, so a
  suspiciously-high retry rate is visible.
- **Failures** — every terminal failure, with enough `detail` to diagnose
  without needing to reproduce.
- **AI Gateway analytics** — token usage and request counts per provider,
  already visible in Cloudflare's AI Gateway dashboard by default; no extra
  work needed beyond making sure every LLM call actually routes through it
  (already required since Stage 5).

### 2.4 Where to look

Cloudflare's Workers observability/logs dashboard, filtered by
`incident_id`, reconstructs one incident's full story across all five
Workers. `OBSERVABILITY.md` (produced in Stage 18) documents the exact
filter/query to use — keep that document's example current as the system
evolves, it's the fastest way for anyone (including future-you) to debug a
specific incident's history.

---

## 3. Security Spec

| Concern | Mitigation in this project |
|---|---|
| **Prompt injection** | Timeline events and knowledge-base content are user/ingestion-supplied text that gets embedded into LLM prompts — treat all of it as untrusted. Prompts should clearly delineate "data" from "instructions" (e.g. wrapping retrieved/user content in clear delimiters and instructing the model that content within those delimiters is data to reason about, not instructions to follow). This won't make injection impossible, but reduces the easy cases. Document this as a known residual risk in the README, not a solved problem. |
| **RAG poisoning** | Since knowledge_sources content flows into prompts, a malicious or corrupted runbook could steer agent output. Mitigation for this project's scope: knowledge_sources ingestion is an authenticated, internal action (not a public upload endpoint) — there's no path for an untrusted third party to inject content into the corpus. Document that a production version handling public/crowdsourced runbooks would need content review before ingestion — out of scope to build here. |
| **Secret management** | Every API key/token lives in Wrangler secrets (per-worker, set independently — see Stage 6's manual steps), never committed, never logged. Verified explicitly in Stage 17's audit pass. |
| **Rate limiting** | Not built for this challenge submission (would matter more once genuinely API-first/public) — document as a roadmap item. If trivially available via a Cloudflare feature you're already using, mention it, but don't build custom rate-limiting infrastructure now. |
| **Input validation** | Every endpoint validates required fields and types before touching D1/DO (Stage 4 onward) — reject early with clear 400s, don't let malformed input reach business logic. |
| **Output sanitization** | LLM-generated text (root cause, recommendations, narrative summary) is rendered as plain text/structured data in the frontend, not as raw HTML — if the frontend ever renders any of it as HTML (e.g. markdown-to-HTML for the narrative summary), it must be sanitized before rendering to prevent stored-XSS via LLM output that happens to contain HTML-like text. |
| **Authentication** | Bearer token against `users`, required on all mutating endpoints (Stage 17). |
| **Authorization** | For this project's scope (small trusted team), authorization is binary (authenticated or not) rather than role-based — document this as a simplification; a production version would add role checks (e.g. only certain users can approve reviews). |
| **Replay attacks** | Idempotency keys (Stage 4) already prevent duplicate-submission replay from causing duplicate side effects. Bearer tokens don't expire mid-session in this simplified auth model — document that a production version would want short-lived tokens with refresh, out of scope here. |

---

## 4. Code Quality Standards

Applies to all five Worker projects and the frontend, every stage:

- **No TODOs left in committed code.** If something is deliberately
  deferred, it belongs in the README's roadmap/known-limitations section,
  not a `// TODO` comment that nobody will revisit.
- **No dead code.** Delete debug routes/methods once their stage's purpose
  is served (the temporary `/debug/ping-all` and LLM test routes from early
  stages should be removed or clearly gated behind a dev-only flag by the
  time of final deployment — Stage 20 should include a pass checking for
  this).
- **No duplicated logic.** If the same validation/formatting/error-handling
  pattern appears in three places, it belongs in `/packages/shared` or a
  core-api-local shared module, not copy-pasted.
- **Typed interfaces.** Every RPC method's input/output shape is a named
  TypeScript type/interface, matching the Agent Contracts in
  `00-architecture-and-contracts.md` §3 exactly — not an inline anonymous
  object type that can drift from the documented contract.
- **Consistent folder structure** across all five worker projects (same
  relative layout for src/, types/, tests/) so moving between them doesn't
  require re-learning conventions each time.
- **Small functions.** If a function is doing "parse the request, validate
  it, call the agent, persist the result, log it" all in one block, split
  it — each of those is a separate concern.
- **Dependency injection where useful** — e.g. passing a D1 handle into the
  retrieval function as a parameter rather than importing a global D1
  binding reference inside it, which makes it testable in isolation (ties
  back to the Unit testing category in §1).
- **Meaningful commit messages** — the commit message given at the end of
  each stage prompt in `02-stage-prompts.md` is a minimum, not a ceiling; if
  a stage's actual work diverged from the plan in some notable way, say so
  in the commit body, not just the subject line.
