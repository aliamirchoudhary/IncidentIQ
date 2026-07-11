# IncidentIQ — Your Manual Setup Steps (Human Side)

This is everything **you** do outside of opencode: account setup, Cloudflare
dashboard/CLI actions, API keys, git commits, and manual verification.
Organized to match `02-stage-prompts.md` stage-for-stage (Stage 0–21, 22
stages total — Stage 8 is the new Validation Gate).

**This project deploys incrementally, not all at once at the end.** Several
stages below have a "deploy to production" step that is not optional — skip
it and you're trading a five-minute check now for a much worse surprise
later.

---

## One-Time Setup (before Stage 0)

1. **Create/confirm your Cloudflare account** at https://dash.cloudflare.com — free tier is sufficient.
2. **Install Node.js** (LTS): check with `node -v`.
3. **Install Wrangler globally:**
   ```
   npm install -g wrangler
   wrangler --version
   ```
4. **Authenticate Wrangler:**
   ```
   wrangler login
   ```
5. **Get a Google Gemini API key** (free tier) — do this one first, Gemini is now the PRIMARY provider, not the fallback: https://aistudio.google.com → Get API Key.
6. **Get an OpenRouter API key** (free, fallback provider): https://openrouter.ai → API Keys → create.
   Save both keys in a password manager, not a plain text file in the repo.
7. **Create a Cloudflare AI Gateway:** dashboard → AI → AI Gateway → Create Gateway (e.g. name it `incidentiq`). Note the gateway ID and your account ID.
8. **Create a GitHub repo** and clone it locally.
9. **Install opencode in VS Code** and open the cloned repo.
10. Read `00-architecture-and-contracts.md` and `04-quality-ops-security.md` yourself, once, before Stage 0 — you'll be asked to confirm opencode's understanding of these in Stage 0, which is a lot easier if you've actually read them first rather than skimming opencode's summary cold.

---

## Stage 0 — Architecture Lock-In

1. Read `00-architecture-and-contracts.md` yourself if you haven't already (see One-Time Setup #10).
2. Read opencode's six output sections carefully against that document — you need to be able to tell if its restatement is actually correct, not just plausible-sounding.
3. Specifically weigh in on the confirmed decisions: ingestion in core-api, `/api/v1` prefix + `{data}/{error}` envelope, the Validation Gate living in core-api not a Worker.
4. Save the six sections as `ARCHITECTURE.md` at the repo root.
5. `git add ARCHITECTURE.md && git commit -m "docs: architecture lock-in (ARCHITECTURE.md)"`

---

## Stage 1 — Monorepo Skeleton — First Production Deploy

1. Confirm the local multi-worker dev command works — run it, watch all five workers boot.
2. Hit the local ping-all endpoint, confirm real responses from all four agent workers.
3. **Deploy all five workers to Cloudflare now**, agent workers first, core-api last:
   ```
   cd workers/timeline-agent && wrangler deploy
   cd ../rootcause-agent && wrangler deploy
   cd ../prevention-agent && wrangler deploy
   cd ../moderator-agent && wrangler deploy
   cd ../core-api && wrangler deploy
   ```
4. Hit the **production** ping-all URL and confirm the same real responses come back. If it fails, stop here until fixed — a broken Service Binding here will silently break every later stage.
5. Check all five `package.json` files for stray `express`/`mongoose` deps.
6. `git commit -m "chore: scaffold 5-worker monorepo with service-binding RPC skeleton, deployed to production"`

---

## Stage 2 — D1 Schema & Migrations — Local + Remote

1. Create the D1 database:
   ```
   cd workers/core-api
   wrangler d1 create incidentiq-db
   ```
   Put the printed `database_id` into core-api's `wrangler.jsonc`.
2. Apply the migration locally, then remotely:
   ```
   wrangler d1 migrations apply incidentiq-db --local
   wrangler d1 migrations apply incidentiq-db --remote
   ```
3. Confirm both, and confirm you see **11 tables** now, including the new `incident_events` table added after the Stage 0 review (it caught a real gap: raw submitted events and TimelineAgent's processed output need separate tables):
   ```
   wrangler d1 execute incidentiq-db --local --command "SELECT name FROM sqlite_master WHERE type='table';"
   wrangler d1 execute incidentiq-db --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
   ```
4. Confirm the migration file is under `workers/core-api/migrations/`, not `packages/core-api/migrations/` — check this explicitly, opencode proposed the wrong path in Stage 0's open questions.
5. Read `docs/schema.md` — confirm each mandatory challenge requirement maps to a table, and that `incidents`/`knowledge_sources` have the `deleted_at` soft-delete column.
6. `git commit -m "feat(db): D1 schema and migration (with soft-delete support), applied locally and to remote production"`

---

## Stage 3 — Durable Object State Machine — Deploy & Verify

1. Confirm core-api's `wrangler.jsonc` has the DO binding + migration entry.
2. Run the local state-machine walk-through, confirm illegal transitions are rejected and the `version` field increments correctly.
3. **Run the concurrency test yourself**: fire two simultaneous requests attempting the same transition and confirm exactly one succeeds. This is a new, important check — don't skip it just because HITL review logic doesn't exist yet; it's testing the underlying DO guarantee, not the review feature.
4. Redeploy core-api, re-run both the walk-through and the concurrency test against the deployed instance.
5. `git commit -m "feat(do): Incident Room durable object state machine with version tracking and concurrency guarantees, verified locally and in production"`

---

## Stage 4 — Core Ingestion API

1. Run the smoke-test script locally, including the idempotency test.
2. **Verify raw events land in `incident_events`, not `timeline_entries`**:
   ```
   wrangler d1 execute incidentiq-db --local --command "SELECT * FROM incident_events ORDER BY created_at DESC LIMIT 5;"
   ```
   `timeline_entries` should still be empty at this point — it doesn't get written until TimelineAgent runs in Stage 7. If you see rows in `timeline_entries` already, that's the old conflated behavior — send it back.
3. Redeploy core-api, re-run the exact same smoke test against production.
4. Manually curl one endpoint yourself against production to build independent confidence.
5. Spot-check that responses actually follow the `{data: ...}` / `{error: {code, message}}` envelope from the API reference — this convention needs to be right from this stage forward.
6. `git commit -m "feat(api): idempotent, versioned incident ingestion endpoints per API reference, deployed and verified"`

---

## Stage 5 — AI Gateway + LLM Utility (Gemini Primary)

1. **Set secrets locally** for dev (in `workers/timeline-agent/.dev.vars` — gitignored!), Gemini first since it's primary now:
   ```
   GEMINI_API_KEY=...
   OPENROUTER_API_KEY=sk-...
   ```
2. **Set production secrets** on timeline-agent:
   ```
   cd workers/timeline-agent
   wrangler secret put GEMINI_API_KEY
   wrangler secret put OPENROUTER_API_KEY
   ```
3. Hit the local debug method, read the actual text response, confirm it's real and confirm (from the response's `provider` field) that Gemini actually served it under normal conditions.
4. Redeploy timeline-agent and core-api, hit the debug method through core-api's **production** Service Binding.
5. Check the AI Gateway dashboard → Logs.
6. Temporarily break the **Gemini** key (not OpenRouter — the fallback direction flipped), confirm fallback to OpenRouter works, then fix it back.
7. Double-check `.dev.vars` is gitignored.
8. `git commit -m "feat(llm): shared AI Gateway utility (Gemini primary, OpenRouter fallback), proven working in production via timeline-agent"`

---

## Stage 6 — Agents SDK Across Four Workers — Deploy & Verify

1. Run the local "pong" round-trip proof.
2. **Set production secrets for all four agent workers now** (Gemini first, then OpenRouter, matching Stage 5's order):
   ```
   cd workers/rootcause-agent && wrangler secret put GEMINI_API_KEY && wrangler secret put OPENROUTER_API_KEY
   cd ../prevention-agent && wrangler secret put GEMINI_API_KEY && wrangler secret put OPENROUTER_API_KEY
   cd ../moderator-agent && wrangler secret put GEMINI_API_KEY && wrangler secret put OPENROUTER_API_KEY
   ```
3. Redeploy all four agent workers, then core-api.
4. Re-run the pong round-trip against the full production deployment — second-most important remote check in the project after Stage 1's.
5. Spot-check that each agent worker's input/output TypeScript types actually match the Agent Contracts table in `00-architecture-and-contracts.md` §3 — this is worth eyeballing yourself now, before four stages of real logic get built on a possibly-wrong shape.
6. Update `01-universal-continuity-prompt.md`'s architecture-decisions list with anything real that got decided here.
7. `git commit -m "feat(agents): Cloudflare Agents SDK wired into all four agent workers with contract-matched types, verified in production"`

---

## Stage 7 — Timeline Agent (Real Logic)

1. If opencode built the deterministic placeholder first, review that output before letting it swap in the LLM version.
2. Read the two real test outputs (messy incident, clean incident).
3. Check `agent_activity_logs` and confirm rows include `request_id` and the DO `version` at time of write:
   ```
   wrangler d1 execute incidentiq-db --local --command "SELECT * FROM agent_activity_logs ORDER BY created_at DESC LIMIT 10;"
   ```
4. `git commit -m "feat(agent): timeline-agent produces real ordered timelines per its contract, via Service Binding RPC"`

---

## Stage 8 — Validation Gate (NEW)

1. This is a new stage — read `00-architecture-and-contracts.md` §3.2 yourself before reviewing opencode's implementation, so you know what "correct" looks like.
2. Test the invalid path yourself: submit a deliberately bad timeline (missing timestamps, too few events) and confirm the incident stays in `TimelineDone` rather than advancing, and that a real issues summary lands in `conversations`:
   ```
   wrangler d1 execute incidentiq-db --local --command "SELECT * FROM conversations ORDER BY created_at DESC LIMIT 5;"
   ```
3. Test the valid path: a clean timeline should advance to the new `Validated` state.
4. Confirm you can still call `POST /incidents/{id}/events` on the "stuck" incident from step 2, add better data, and re-trigger analysis successfully.
5. Redeploy core-api, re-verify both paths in production.
6. `git commit -m "feat(validation): deterministic Validation Gate between Timeline and RootCause, closing the garbage-in-garbage-out risk"`

---

## Stage 9 — RAG Pipeline

1. Read the two-different-queries test output carefully — this and Stage 10's test are the two most important checks in the project for the RAG grading criterion.
2. Personally do the delete-a-document test yourself — since Stage 2 added soft-delete, this is now a clean `deleted_at` toggle rather than a destructive edit:
   ```
   wrangler d1 execute incidentiq-db --local --command "UPDATE knowledge_sources SET deleted_at=CURRENT_TIMESTAMP WHERE id=X;"
   ```
   Re-run the same query, confirm results changed, then restore it (`deleted_at=NULL`).
3. Check the AI Gateway dashboard — confirm embedding calls show up too.
4. `git commit -m "feat(rag): knowledge base ingestion, embeddings, and similarity retrieval per RAG spec, proven corpus-dependent"`

---

## Stage 10 — Root-Cause Agent

1. This stage's delete-chunk-and-rerun-generation test is **the** single most important test in the entire project for the RAG criterion. Do it yourself personally. Compare both outputs side by side.
2. Watch the logs during the tool-calling test — confirm the LLM actually decided to invoke the status-correlator tool, not just that code for it exists.
3. Confirm the state transition is `Validated → RootCauseDone`, not the old `TimelineDone → RootCauseDone` — this changed with Stage 8's insertion, worth double-checking opencode updated it correctly rather than leaving a stale transition rule.
4. `git commit -m "feat(agent): rootcause-agent with RAG-grounded analysis and real LLM-driven external tool calling, per contract"`

---

## Stage 11 — Prevention Agent

1. Read the recommendations output critically — specific to this root cause, or generic?
2. `git commit -m "feat(agent): prevention-agent with grounded, cited recommendations, per contract"`

---

## Stage 12 — Moderator Agent

1. Read the full assembled report yourself — coherent end to end?
2. `git commit -m "feat(agent): moderator-agent assembles final draft report, per contract"`

---

## Stage 13 — Full Pipeline Auto-Orchestration — Deploy & Verify

1. Do one full manual local run: submit, feed events, one `analyze` call, poll `GET /report` until `AwaitReview`. Time it for your demo script later.
2. Deliberately break validation (submit a bad timeline) mid-chain and confirm the chain halts at `TimelineDone`, doesn't skip to RootCause.
3. Deliberately break one agent (bad key temporarily) and confirm the chain halts at its last successful state.
4. **Deploy the whole system to production** and re-run the identical full-chain test live — first time the complete real system runs together, treat it as a major checkpoint.
5. `git commit -m "feat(pipeline): automatic end-to-end orchestration including Validation Gate, verified in production"`

---

## Stage 14 — Human-in-the-Loop Review

1. **Personally** try to call `/review` on an incident not in `AwaitReview` — locally AND in production.
2. Run all three paths (approve / reject / modify) yourself, inspect D1 rows after each.
3. **Re-run Stage 3's concurrency test for real this time**, against actual `/review` calls: fire two simultaneous approval requests on the same AwaitReview incident, confirm exactly one succeeds and the incident is not double-finalized or corrupted.
4. Confirm a rejection targeting `timeline` correctly re-triggers Validation too on the next analyze call (not just RootCause) — this is a subtlety introduced by Stage 8, worth checking explicitly.
5. `git commit -m "feat(hitl): enforced human review gate with real concurrency proof, verified in production"`

---

## Stage 15 — Persistent Memory

1. Test `/incidents/similar` with a query matching a test incident.
2. Test the per-user confidence threshold override with a borderline case.
3. `git commit -m "feat(memory): cross-incident semantic search + per-user preference memory"`

---

## Stage 16 — React Frontend (Stay Thin)

1. Walk through the entire flow using ONLY the browser UI.
2. **Actively check that the frontend stayed thin and logic-free** — this is the stage where the risk is opencode adding more than asked, or quietly re-implementing a rule (like a confidence check or state-transition rule) in React instead of trusting the API. If you see either, push back.
3. Try to break it a little (empty form submission) — confirm errors surface in the UI.
4. `git commit -m "feat(frontend): minimal React demo client per frontend philosophy — uploads, review, visualization, status only"`

---

## Stage 17 — Auth & Security

1. Decide with opencode: session-based vs stateless bearer tokens.
2. Generate a test token/user, confirm unauthenticated-rejected and authenticated-succeeds, locally AND in production.
3. Read `SECURITY.md` against `04-quality-ops-security.md` §3's table — confirm every row is addressed (built, or explicitly deferred with a reason), not silently skipped.
4. `git commit -m "feat(security): API token auth, CORS hardening, and full security-spec coverage in SECURITY.md"`

---

## Stage 18 — Observability

1. Go into the Cloudflare dashboard for each of your five workers → Logs. Filter by one `incident_id` across multiple workers, following `OBSERVABILITY.md`'s example, against production.
2. Confirm log lines include `request_id` and `version`, not just `incident_id`.
3. `git commit -m "chore(observability): standardized structured logging with correlation IDs across all workers"`

---

## Stage 19 — Automated Testing

1. Run the test suite locally, watch it pass.
2. Run it (or an environment-appropriate variant) against production too.
3. Confirm the Validation Gate's valid/invalid paths are covered as explicit automated tests, not just the four agents.
4. If anything failed and got "fixed" by weakening an assertion, catch this and push back.
5. `git commit -m "test: automated suite per the full Testing Taxonomy, covering Validation Gate, RAG, HITL, concurrency, and chain integrity"`

---

## Stage 20 — CI/CD Automation

1. **Create a Cloudflare API token** for CI (dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template or custom-scoped).
2. Add as **GitHub repo secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
3. Double-check production secrets are independently set for all five workers (you should have done this in Stages 5 and 6 — re-verify, don't assume).
4. Push a small test commit to `main`, watch GitHub Actions deploy all five workers in order, then the frontend.
5. **Personally** run the full submit → review → finalize flow against the LIVE production URL one final time.
6. `git commit -m "chore(ci): GitHub Actions automation for the five-worker deployment pipeline"`

---

## Stage 21 — Documentation & Demo Prep

1. Read the entire README as if you were a grader who's never seen this project.
2. Check the **API Reference** section specifically — every `/api/v1` endpoint should actually be documented.
3. Check the **Roadmap** section is clearly labeled future/aspirational and pulls from `05-product-vision-roadmap.md` rather than reading like committed work.
4. Actually run the demo script once, live, start to finish, timing it — watch the Cloudflare dashboard logs during the run to confirm you can see the request traveling across the five workers plus the Validation Gate.
5. Do a final top-to-bottom pass of `cloudf.txt` (the original challenge brief) against what you actually built.
6. `git commit -m "docs: final open-source-ready README, API reference, roadmap, demo script, requirement mapping"`
7. Submit: repo URL + live URL.

---

### A note on pacing
This 22-stage (0–21) plan is thorough by design — the Validation Gate,
contract-level typing discipline, incremental production deployment, and the
expanded testing/observability/security scope all cost real time but each
maps to either a graded requirement or a concrete robustness improvement. If
you're tight on the 10-12 day window, Stage 15 (cross-incident memory) is the
most compressible without sacrificing a mandatory requirement.
