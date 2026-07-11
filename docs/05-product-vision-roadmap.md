# IncidentIQ — Product Vision & Roadmap (Future, Not This Build)

**Read this note before reading anything else in this document.**

Everything below is documentation-only — it costs nothing to write and
demonstrates product thinking to anyone (a grader, a future employer, a
future you) reading the README. **None of it is a build stage. None of it
should be implemented as part of the 22-stage plan in `02-stage-prompts.md`.**

I want to be direct about why I'm drawing that line rather than just
including it: multi-tenancy, billing, webhooks, and third-party integrations
(Slack, PagerDuty, GitHub, Jira) are each, individually, a multi-day project
on their own — implementing even one properly (with real auth boundaries,
real webhook signature verification, real billing edge cases) would
meaningfully eat into a 10-12 day challenge window that already has 22
stages of mandatory-and-graded work in it. None of these are graded by the
challenge brief. Building any of them for real risks either running out of
time on the things that ARE graded, or shipping half-built versions of
things that ARE NOT graded — both are worse outcomes than a README section
that says "here's how this would evolve into a product" and stops there.

If, after the challenge submission, you decide to actually build toward
this roadmap, treat this document as the starting brief for that separate
effort — at that point it stops being aspirational and becomes real
scoping work, with its own architecture lock-in stage, its own contracts,
the same rigor as the rest of this project got. But that's a deliberate,
separate decision to make later, not something to slide into during the
current build because it seemed natural "while you're in there."

---

## Future Roadmap (documentation only)

### Phase 1 (this challenge): Single-tenant, API-first incident postmortem engine
What's actually being built. Already fully specified elsewhere in this
document set.

### Phase 2 (future): API monetization
- Public API documentation site, generated from the API reference in
  `00-architecture-and-contracts.md` §9.
- Per-account API keys (the auth model in Stage 17 — bearer tokens tied to
  `users` — is already structured to extend naturally into this; it
  wouldn't require an architecture change, just a billing layer on top).
- Usage-based or tiered pricing (e.g. free tier with limited incidents/month,
  paid tiers for higher volume and priority LLM routing).

### Phase 3 (future): SaaS multi-tenancy
- `users` table would need an `organization_id` (or similar) to properly
  isolate accounts — the current single-tenant schema does not have this
  and would need a real migration, not a bolt-on.
- Durable Object naming (`idFromName(incident_id)`) would need
  organization-scoping to prevent any theoretical cross-tenant ID collision.
- Row-level authorization (a user can only see incidents within their
  organization) — the current binary authenticated/not-authenticated model
  in Stage 17 is explicitly NOT sufficient for this and would need real
  role/tenant checks.

### Phase 4 (future): Enterprise features
- Role-based access control (admin / reviewer / read-only).
- SSO (Cloudflare Access integration — already gestured at in
  `SECURITY.md`'s "how production would extend this" section from
  Stage 17).
- Audit export (the `agent_activity_logs` and `reviews` tables already
  contain the right data for this — it's a reporting/export feature on top
  of existing data, not a new data model).

### Phase 5 (future): Integrations
- **Slack** — post a notification when an incident reaches `AwaitReview`,
  with an approve/reject action directly in the Slack message.
- **PagerDuty** — auto-create an IncidentIQ postmortem when a PagerDuty
  incident resolves, pre-filled with PagerDuty's own timeline data if
  available.
- **GitHub** — link a finalized postmortem to the PR/commit that ultimately
  fixed the root cause, and optionally auto-open a tracking issue for each
  recommendation.
- **Jira** — same idea as GitHub, for teams using Jira for follow-up
  tracking instead of/alongside GitHub Issues.
- **Webhooks** — a generic outbound webhook on key events (`incident.
  finalized`, `incident.needs_review`) so teams can build their own
  integrations without waiting on first-party ones.

Each of these would get its own architecture-lock-in pass, its own agent (or
non-agent integration) contract, and its own stage plan, exactly like this
project got — not built ad hoc.

---

## Why this belongs in the README anyway

A grader or future reader benefits from seeing that the current design
choices (bearer-token auth structured for future API keys, an
`organization_id`-shaped gap that's at least been identified, an
audit-trail schema that already supports export) weren't accidental — they
were made with an eye toward not painting the project into a corner, even
though none of the future phases were built. That's a genuinely useful
thing to demonstrate. Just don't let "useful to demonstrate" turn into
"tempting to build early" — the discipline of NOT building this now, and
saying so explicitly, is itself part of what makes the actual challenge
submission credible.
