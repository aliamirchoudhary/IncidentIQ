# IncidentIQ — Universal Continuity Prompt

Paste the block below into a **new opencode chat session** any time you're
continuing work (new day, new terminal, context got reset, etc.). Before
pasting, edit the two bracketed lines near the top (current stage, and a
one-line status note) — that's the only editing this needs.

Keep this block in sync with reality: if the architecture changes mid-project
(e.g. you decide to migrate embeddings from D1 to Vectorize, or add
re-ranking to RAG retrieval), update the "Key architecture decisions locked
in so far" section below permanently, so every future session starts from
the truth, not the original plan.

---

```
PROJECT CONTEXT — READ FULLY BEFORE DOING ANYTHING

I'm building IncidentIQ: an AI-powered incident postmortem and root-cause
analysis platform, submitted as a Cloudflare Native AI Agent Challenge project.
We are partway through a staged build plan. Do not start writing code yet —
read this whole context block first.

CURRENT STAGE: [ FILL IN — e.g. "Stage 10 (Root-Cause Agent), about to start" ]
LAST SESSION STATUS: [ FILL IN — e.g. "Stage 9 RAG retrieval is done and
tested; Stage 10 not started" or "Stage 10 in progress, RAG wiring done,
confidence-threshold logic not written yet, was debugging why state
wouldn't advance to RootCauseDone" ]

STACK — DO NOT DEVIATE FROM THIS WITHOUT ASKING ME:
- Backend + API: Cloudflare Workers, TypeScript. NOT Express. NOT a separate
  Node server process.
- MULTI-WORKER ARCHITECTURE: 5 separately deployable Worker projects, not
  one monolith. `core-api` owns the public REST API, D1, and the Durable
  Object. `timeline-agent`, `rootcause-agent`, `prevention-agent`,
  `moderator-agent` are each their own Worker, called from core-api via
  Service Bindings (RPC via WorkerEntrypoint classes) — never plain HTTP
  fetch to a public URL. Do not collapse these back into one Worker.
- Database: Cloudflare D1 (SQL/SQLite), owned exclusively by core-api. NOT
  MongoDB. ("MERN" in this project means React frontend only — the rest of
  the acronym doesn't apply.)
- State management: Cloudflare Durable Objects (one "IncidentRoom" per
  incident), owned exclusively by core-api. Agent workers never touch the DO
  or D1 directly — they're pure compute; core-api persists everything based
  on what each agent worker's RPC response reports.
- Agent framework: Cloudflare Agents SDK (the `agents` npm package or its
  current equivalent — verify current package/API against
  developers.cloudflare.com/agents if anything seems off, this SDK moves
  fast), configured inside each of the four agent workers.
- LLM access: Cloudflare AI Gateway. **Gemini is PRIMARY, OpenRouter
  free-models pool is FALLBACK** (flipped from an earlier draft — see
  00-architecture-and-contracts.md §7 for why), via a shared module in
  /packages/shared. Every LLM and embedding call MUST go through an AI
  Gateway endpoint, never call a provider directly.
- Validation Gate: a deterministic (no LLM) check between TimelineAgent and
  RootCauseAgent, living inside core-api, not a separate Worker — catches a
  bad timeline before expensive reasoning builds on it. Full spec in
  00-architecture-and-contracts.md §3.2.
- RAG storage: knowledge documents + embeddings in D1 (or Vectorize, only if
  we explicitly decided to add it — check the architecture decisions section
  below); retrieval logic lives in core-api only.
- API-FIRST, THIN FRONTEND: core-api's REST API is the actual product,
  designed as if a third party might consume it directly someday (versioned
  routes, consistent response envelope). The React frontend (built last, in
  Stage 16) is a deliberately minimal demonstration client — don't let it
  grow beyond what a stage prompt asks for, and never let frontend
  convenience shape API design.
- DEPLOY EARLY, DEPLOY OFTEN: production deployment isn't saved for the end
  — several stages explicitly redeploy and re-verify against real Cloudflare
  infrastructure along the way (after Stages 1, 2, 3, 5, 6, 8, 13, 14, 17,
  and 18). Don't skip these just because "it worked locally."

KEY ARCHITECTURE DECISIONS LOCKED IN SO FAR (update this list stage by stage,
do not silently re-decide something already settled here):
- Multi-worker: core-api (D1 + DO + public API, orchestration + persistence
  only, never calls an LLM itself) plus 4 separate agent workers
  (timeline/rootcause/prevention/moderator), connected via Service Binding
  RPC. Agents never call each other or know about each other. Decided
  Stage 0.
- API-first: core-api's REST API is the real product; frontend is a thin
  demo client built last (exactly 5 pages, no more). Decided Stage 0.
- Validation Gate: deterministic, lives inside core-api (not a Worker),
  sits between the TimelineDone and Validated states. Built Stage 8.
- LLM order: Gemini primary, OpenRouter fallback.
- [ FILL IN as further decisions get made, e.g.: whether ingestion lives in
  core-api or its own worker (decided Stage 0 — core-api); session-based vs
  stateless auth tokens (Stage 17); Vectorize vs D1-only embeddings
  (Stage 9). ]
- [ Add more lines here as the project progresses. ]

FULL STAGE PLAN: I have four supporting documents now:
- 02-stage-prompts.md — a detailed prompt + acceptance checklist for every
  stage from 0 to 21 (22 stages total; Stage 0 = architecture lock-in, no
  code; Stage 8 = the Validation Gate; Stage 21 = final docs).
- 00-architecture-and-contracts.md — the canonical technical spec:
  architecture principles, exact agent contracts (input/output shapes for
  every agent), Durable Object internals, D1 schema detail, RAG detail, LLM
  strategy, tool contracts, API reference, frontend philosophy. When a stage
  prompt says "per the Agent Contract" or "per the API reference," it means
  this document — read the relevant section before implementing.
- 04-quality-ops-security.md — testing taxonomy, observability spec,
  security spec, code quality standards.
- 05-product-vision-roadmap.md — future/aspirational SaaS vision, explicitly
  NOT part of the current build (documentation only, referenced only in the
  final README stage).
I will paste the specific stage prompt for whatever we're working on right
after this context block. Treat that stage prompt as the actual task, the
two spec documents as the authoritative "what does this look like exactly,"
and this block as background continuity context only.

GROUND RULES THAT APPLY TO EVERY STAGE, NOT JUST ONE:
- No mocked LLM responses anywhere, ever — this is a hard, explicit
  requirement of the underlying challenge.
- RAG must be real similarity-based retrieval that provably returns
  different results for different queries/corpus contents — not "paste
  everything into the prompt."
- Human-in-the-loop approval must be structurally enforced at the API/state-
  machine level — an incident cannot reach a finalized state without a
  recorded human review, and this must be actively defended against bypass
  attempts, not just assumed.
- The API on core-api is the real product — design it like something a
  third party could integrate against. The frontend is a thin demo client
  built last; don't let it grow beyond what a stage prompt explicitly asks
  for.
- Deploy to production and re-verify remotely at the checkpoints the stage
  prompts call out — don't defer all real-infrastructure testing to the
  final deployment stage.
- No toy-app shortcuts — everything should hold up under a critical
  technical review, not just be the fastest thing that compiles once.
- Only work on the stage I explicitly hand you. Don't start on the next
  stage's work even if it seems like a natural continuation — finish this
  stage's checklist, tell me what's done, and STOP.
- If something in the current stage prompt is ambiguous, or you're about to
  silently assume a convention (naming, folder structure, library choice,
  error-response shape, etc.) that wasn't explicitly stated, STOP and ask me
  first. I would much rather answer a quick question than redo work built on
  a wrong assumption several stages later.
- When you finish a stage's checklist items, summarize plainly what you did
  and did not complete, and flag anything you're unsure actually works
  correctly versus anything you've concretely verified yourself (e.g. ran
  it, saw real output, deployed and re-tested against production) — I need
  to know the difference.

Confirm you've understood this context, then wait for me to paste the
specific stage prompt.
```

---

### Tip for keeping this file useful over time
After each stage, spend 30 seconds updating:
- `CURRENT STAGE` and `LAST SESSION STATUS`
- `KEY ARCHITECTURE DECISIONS LOCKED IN SO FAR` — only if a real decision got made that a future session needs to know about (not every implementation detail, just things that would break something if re-decided differently later)

This file is the only thing standing between you and re-explaining the whole project from scratch every time your terminal session resets — keep it accurate and it will save you far more time than it costs.
