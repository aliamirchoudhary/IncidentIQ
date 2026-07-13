# Requirement-to-File-Path Mapping

Maps every Cloudflare AI Challenge mandatory requirement to the specific files that implement it.

---

## Mandatory Requirements

### 1. Agent (Workers / Multi-Worker Architecture)

The system uses 5 Workers: core-api (orchestration + persistence) + 4 stateless agent Workers. Each agent is independently deployable, has a single responsibility, and is called via Service Binding RPC — never HTTP.

| File | Role |
|---|---|
| `workers/core-api/src/index.ts` | Orchestration: routes HTTP requests, calls agent RPCs, persists results |
| `workers/timeline-agent/src/index.ts` | TimelineAgent: converts raw events to ordered timeline via LLM |
| `workers/rootcause-agent/src/index.ts` | RootCauseAgent: identifies root cause with RAG + tool calling |
| `workers/prevention-agent/src/index.ts` | PreventionAgent: generates preventive recommendations |
| `workers/moderator-agent/src/index.ts` | ModeratorAgent: assembles draft report from all prior outputs |
| `workers/core-api/wrangler.jsonc` | Declares Service Bindings to all 4 agent Workers |
| `packages/shared/src/llm/callLLM.ts` | Shared LLM utility used by TimelineAgent, PreventionAgent, ModeratorAgent |
| `workers/rootcause-agent/src/call-llm-with-tools.ts` | Custom LLM + tool-calling for RootCauseAgent |

### 2. RAG (Retrieval-Augmented Generation)

RAG is used by RootCauseAgent (primary) and PreventionAgent (secondary). Knowledge is retrieved before agent calls and passed in as RPC arguments — agents never query D1 themselves.

| File | Role |
|---|---|
| `workers/core-api/src/rag/index.ts` | RAG module entry point (re-exports) |
| `workers/core-api/src/rag/types.ts` | Chunk, retrieval result types |
| `workers/core-api/src/rag/chunking.ts` | Paragraph-level document chunking with overlap |
| `workers/core-api/src/rag/embed.ts` | Embedding generation via Workers AI (`@cf/baai/bge-base-en-v1.5`) |
| `workers/core-api/src/rag/retrieval.ts` | Cosine similarity retrieval (top-k=3) |
| `workers/core-api/src/rag/ingestion.ts` | Document ingest, soft-delete, restore |
| `workers/core-api/src/rag/seed.ts` | Seed documents: 5 runbooks + 2 past incidents |
| `workers/core-api/src/index.ts:641-659` | core-api calls `retrieveRelevantKnowledge` before RootCauseAgent |
| `workers/core-api/src/index.ts:724-741` | core-api calls retrieval again before PreventionAgent |
| `tests/rag/proof.test.ts` | Two automated proofs: corpus-dependence (Proof A) and delete-changes-results (Proof B) |

### 3. HITL (Human-in-the-Loop)

Structurally enforced at the state-machine level. No code path reaches `Finalized` without a recorded row in the `reviews` table.

| File | Role |
|---|---|
| `workers/core-api/src/incident-room.ts` | DO state machine: `AwaitReview → Finalized` only via explicit allow-list |
| `workers/core-api/src/index.ts:321-325` | `POST /incidents/{id}/review` endpoint routing |
| `workers/core-api/src/index.ts:1038-1178` | `handleReview()`: validates state, writes reviews row, transitions state |
| `workers/core-api/src/ingestion.ts:230-263` | `getReport()` reads reviews table + verifies approval trail |
| `workers/core-api/migrations/0001_init_schema.sql:42-49` | `reviews` table schema (reviewer_user_id, approved, created_at) |
| `tests/do/concurrency.test.ts` | Concurrency proof: exactly one of two simultaneous approvals succeeds |
| `tests/auth/security.test.ts` | Verifies unauthenticated review attempts are rejected |

### 4. Tool Calling (LLM-Decided Tool Invocation)

RootCauseAgent has access to the StatusCorrelator tool via the Agents SDK. The LLM decides whether to invoke it based on the timeline context.

| File | Role |
|---|---|
| `workers/rootcause-agent/src/status-correlator.ts` | StatusCorrelator tool: checks GitHub, Cloudflare, Atlassian, Vercel status pages |
| `workers/rootcause-agent/src/call-llm-with-tools.ts` | Implements Gemini tool-calling: sends prompt with tool definitions, processes tool response |
| `workers/rootcause-agent/src/index.ts:85-113` | Tool invocation flow: model decides to call StatusCorrelator |
| `workers/core-api/src/index.ts:664` | core-api passes timeline to RootCauseAgent (triggers tool decision) |

The StatusCorrelator tool is distinct from orchestration-internal functions (like `retrieveRelevantKnowledge`) because the LLM genuinely decides whether to invoke it — it is not called unconditionally.

### 5. Persistent Memory / Cross-Incident Learning

Finalized incidents are automatically ingested into the RAG knowledge base. The `/incidents/similar` endpoint enables semantic search across past incidents.

| File | Role |
|---|---|
| `workers/core-api/src/index.ts:1190-1230` | `handleSimilar()`: semantic search across finalized incidents |
| `workers/core-api/src/index.ts:327-335` | `GET /users/{id}/preferences`, `PUT /users/{id}/preferences` |
| `workers/core-api/src/index.ts:1233-1270` | User preferences: confidence threshold override stored as JSON |
| `workers/core-api/src/rag/ingestion.ts:49-73` | `ingestFinalizedIncident()`: auto-ingests finalized incidents as `type='past_incident'` |
| `workers/core-api/migrations/0002_add_user_preferences.sql` | Migration: adds `preferences` column to `users` table |
| `workers/core-api/src/rag/seed.ts:23-28` | Past-incident seed data tagged `type='past_incident'` |

### 6. Real LLM Integration (No Mocked Calls)

All agents make real LLM calls through Cloudflare AI Gateway with Gemini 2.5 Flash as the primary provider. Fallback chain: AI Gateway → direct Gemini → OpenRouter.

| File | Role |
|---|---|
| `packages/shared/src/llm/callLLM.ts` | Shared `callLLM()`: 3-tier fallback with timeout, structured logging, typed errors |
| `workers/rootcause-agent/src/call-llm-with-tools.ts` | RootCauseAgent's custom tool-enhanced LLM calling (same fallback chain) |
| `workers/timeline-agent/src/index.ts:15-21` | TimelineAgent system prompt + LLM call with Gemini |
| `workers/prevention-agent/src/index.ts:14-20` | PreventionAgent system prompt + LLM call with Gemini |
| `workers/moderator-agent/src/index.ts:13-19` | ModeratorAgent system prompt + optional narrative LLM call |
| `workers/rootcause-agent/src/index.ts:15-30` | RootCauseAgent system prompt + tool-calling LLM |
| `workers/core-api/wrangler.jsonc:42-44` | AI binding declaration (`"ai": { "binding": "AI" }`) |

**Provider order in code:** `callLLM.ts` tries AI Gateway → direct Gemini → OpenRouter. `call-llm-with-tools.ts` follows the same pattern. The AI Gateway ID is `05c934a23d9100d41fc6e9c89ab6cbcb` (gateway name: `incidentiq`). Real (non-mocked) responses confirmed in Stage 5 acceptance.

---

## Bonus: Validation Gate

The Validation Gate is not a mandatory requirement, but it is a notable architectural strength — a deterministic quality gate between timeline generation and root-cause analysis that prevents garbage-in-garbage-out without any LLM cost.

| File | Role |
|---|---|
| `workers/core-api/src/validation.ts` | Deterministic checks: event count ≥ 2, timestamp coverage > 50%, contradictory events, large time gaps |
| `workers/core-api/src/index.ts:597-631` | Validation Gate called in `runFullChain` after TimelineAgent succeeds |
| `workers/core-api/src/incident-room.ts` | `Validated` state in transition allow-list; self-loop on failure |
| `tests/unit/validation.test.ts` | Automated unit tests for all Validation Gate checks |
| `tests/failure/injection.test.ts` | Integration test: validation halts chain, recovery on retry |

### Why the Validation Gate matters

The original design doc (Stage 0) skipped straight from TimelineAgent to RootCauseAgent. Adding the Validation Gate between them catches bad timelines (missing timestamps, too few events, contradictions) before expensive LLM reasoning builds on top of them. The gate is deterministic — no LLM cost, just data integrity checks. On failure, the incident stays in `TimelineDone` rather than advancing to a dead-end state, and more events can be added. This single insertion improved the pipeline's robustness more than any other non-LLM change.
