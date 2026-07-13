# IncidentIQ — Security Reference

---

## Security Spec Coverage

| Concern | Status | Notes |
|---|---|---|
| **Prompt injection** | Mitigated, residual risk documented | All user/ingestion-supplied text that enters LLM prompts (timeline events, knowledge-base content) is wrapped in clear delimiters with instructions that the content within is data to reason about, not instructions to follow. This reduces easy injection cases but does not make injection impossible — documented as a known residual risk. |
| **RAG poisoning** | Mitigated (architecture constraint) | `knowledge_sources` ingestion is an authenticated internal action only — there is no public upload endpoint, so no untrusted third party can inject content into the corpus. A production version handling public/crowdsourced runbooks would need content review before ingestion; that is out of scope for this project. |
| **Secret management** | Verified | Every API key and token lives in per-worker Wrangler secrets (`wrangler secret put`), never committed, never logged. Audit pass across all five workers (Stage 17) confirmed zero `console.*` calls in any source file. The bootstrap auth key (`AUTH_BOOTSTRAP_KEY`) is also stored as a Wrangler secret in production and in `.dev.vars` (gitignored) locally. |
| **Rate limiting** | Roadmap item | Not built for this challenge — would matter once API endpoints are public/integrated. If Cloudflare Rate Limiting (dashboard-level) is trivially configurable, it can be enabled without code changes; no custom rate-limiting infrastructure is built. |
| **Input validation** | Built | Every endpoint validates required fields and types before touching D1 or the Durable Object, returning clear 400 errors on malformed input. This has been the pattern since Stage 4. |
| **Output sanitization** | Built (architecture constraint) | LLM-generated text (root cause, recommendations, narrative summary) is rendered as plain text or structured data in the frontend, never as raw HTML. If the frontend ever renders any of it as HTML (e.g. a future markdown renderer), that renderer must sanitize first — this is noted as a future concern but not built because the current frontend renders everything as text. |
| **Authentication** | Built (Stage 17) | Bearer token authentication against the `sessions` table, required on all mutating endpoints (`POST`/`PUT`/`DELETE`/`PATCH` under `/api/v1/`). Tokens are generated via `POST /api/v1/auth/token` using a bootstrap key (`AUTH_BOOTSTRAP_KEY`). Tokens expire after 30 days. GET endpoints (read-only) remain unauthenticated for simplicity. |
| **Authorization** | Simplified (documented) | For this project's scope (small trusted team), authorization is binary — authenticated or not. No role-based checks exist (e.g. no distinction between "reviewer" and "viewer"). A production version would add role checks; this is documented as a deliberate simplification. |
| **Replay attacks** | Partially mitigated | Idempotency keys (Stage 4) prevent duplicate event submissions from causing duplicate side effects. Bearer tokens do not expire mid-session in this simplified auth model — a production version would want short-lived tokens with refresh. |

---

## Authentication Flow

1. **Bootstrap:** An admin generates a token for a user via `POST /api/v1/auth/token` with `user_id` and the configured `AUTH_BOOTSTRAP_KEY`.
2. **Client stores** the returned `token` string.
3. **Every mutating request** includes `Authorization: Bearer <token>` in the request header.
4. **core-api** validates the token against the `sessions` table, checking expiry. Returns `401` on missing/invalid/expired tokens.
5. **GET requests** do not require authentication.

### Token expiry

Tokens are valid for 30 days from creation. No refresh mechanism is built for this project's scope — generate a new token when the old one expires.

### Bootstrap key

The `AUTH_BOOTSTRAP_KEY` environment variable controls who can generate tokens. In production, set this via `wrangler secret put AUTH_BOOTSTRAP_KEY`. The bootstrap key is checked on every call to `POST /api/v1/auth/token`. If `AUTH_BOOTSTRAP_KEY` is not set, token generation is unlocked (anyone can generate a token for any user) — this is the default for local development only.

---

## CORS Configuration

The `ALLOWED_ORIGINS` environment variable (comma-separated list) controls which origins are permitted cross-origin requests. Default for local dev:

```
http://localhost:5173,http://localhost:8787,http://127.0.0.1:8787
```

In production, set this to the actual frontend URL(s). Requests from origins not in the list receive a `Vary: Origin` header and no `Access-Control-Allow-Origin` match.

---

## Secret Audit (Stage 17)

All five workers were audited for accidental secret logging:

| Worker | Source files checked | `console.*` calls found |
|---|---|---|
| core-api | `src/**/*.ts` | 0 |
| timeline-agent | `src/**/*.ts` | 0 |
| rootcause-agent | `src/**/*.ts` | 0 |
| prevention-agent | `src/**/*.ts` | 0 |
| moderator-agent | `src/**/*.ts` | 0 |

API keys are passed through environment variables to the `callLLM` utility function and used only to construct `Authorization: Bearer <key>` HTTP headers. They are never logged, printed, or stringified into any output.

---

## Scope Decisions

### Explicitly deferred (documented in README roadmap)

- Rate limiting (would matter in a public API scenario — not applicable at current scale)
- Token refresh / short-lived tokens (bearer tokens live 30 days — add refresh if this becomes a production service)
- Role-based authorization (current model is binary auth — add roles if the team grows beyond trusted operators)
- Stored-XSS sanitization for LLM output rendered as HTML (not needed while frontend renders content as plain text — add if a markdown renderer is introduced)

### Built

- Bearer token auth on all mutating endpoints
- Token generation with bootstrap key
- CORS origin validation
- Input validation on all endpoints
- Idempotency keys for event submission
- Soft-delete for knowledge_sources (prevents data loss on accidental deletion)
- Secret audit across all workers
