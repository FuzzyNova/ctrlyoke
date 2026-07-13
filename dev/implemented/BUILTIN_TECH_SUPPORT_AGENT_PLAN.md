# Built-in `ctrlyoke-tech-support` Agent

**Created:** July 4, 2026
**Status:** DONE
**Priority:** **v0.1.0 BLOCKER** (confirmed by Nathan, July 4, 2026)
**Effort:** 1–2 days
**Related:** [`ONBOARDING_TOUR_PLAN.md`](ONBOARDING_TOUR_PLAN.md), [`BUILTIN_AGENTS_TEMPLATES_CLEANUP_PLAN.md`](BUILTIN_AGENTS_TEMPLATES_CLEANUP_PLAN.md)

---

## Background

New users learning ctrlyoke have no in-product expert to ask. They must read the
docs site or dig through settings. Because ctrlyoke ships with a set of built-in
agents (`src/templates/agents/`, surfaced via `agents/manifest.json`), we can ship
a **support/onboarding agent** that any harness can load to answer "how do I…"
questions grounded in real product knowledge — turning the tool the user already
has (an AI CLI) into first-line support and deflecting load off `support@ctrlyoke.dev`.

## Goal

Add `src/templates/agents/ctrlyoke-tech-support.agent.md` (+ `manifest.json` entry)
that contains everything an agent needs to answer ctrlyoke questions accurately for
a new user:

- What ctrlyoke is and its core model (harness, workflow, steps, end conditions, sessions).
- The supported harnesses and how to select/configure them (kept in sync with the
  harness list — see the cleanup plan; must **not** mention Gemini once it is removed).
- Workflow file formats (`.ctrlyoke.yaml` / `.ctrlyoke.json` / `.prompt.md`) and the schema basics.
- Context references (`@path`, `#file:`, `#sym:`, `$previous`/`$all`/`$step:N`), agents, skills, MCP.
- Common controls in the dashboard and how to run / pause / resume / retry.
- End conditions, retries, pre-conditions, error behavior.
- Where things live (`.ctrlyoke/` state, logs, history) and basic troubleshooting.
- Pointers to `ctrlyoke.dev/docs` and `support@ctrlyoke.dev` for anything out of scope.

## Design decisions / open questions

- **Grounding & drift.** The agent's knowledge is prose baked into the `.agent.md`.
  It **will** drift from the real product unless there is a single source. Options:
  1. Author it by hand and add it to the "docs coherence" pre-publish check (cheapest; drift risk).
  2. Generate/verify it from the docs site content at build time (more robust; more work).
     Recommendation for v1: **hand-author, and add a checklist item** to re-verify the
     agent whenever harnesses, formats, or major features change (same discipline as
     the `.github/instructions/*` shared memory). Explicitly instruct the agent to say
     "check the current docs at ctrlyoke.dev/docs" rather than inventing specifics it is unsure of.
- **Anti-hallucination framing.** The agent prompt must tell it to answer only from
  the provided knowledge and defer to the docs/support inbox otherwise — a confidently
  wrong support agent is worse than none.
- **Discoverability.** Ties into onboarding: the tour / getting-started panel should
  point users at "ask the ctrlyoke-tech-support agent." Cross-linked with
  [`ONBOARDING_TOUR_PLAN.md`](ONBOARDING_TOUR_PLAN.md).

## Should this block release?

**Decision: YES — v0.1.0 blocker** (Nathan, July 4, 2026). The extension is technically
usable without it, but Nathan is prioritizing a strong new-user story for the first paid
release, and this is cheap, high-leverage support deflection for a solo-maintained launch.
**Gated behind the cleanup plan** — it must reflect the corrected harness list and current
formats, not the stale ones. Tracked in `RELEASE_PLAN.md` §2.9.

## Acceptance

- [x] `ctrlyoke-tech-support.agent.md` authored; accurate against the shipped harness list and formats.
- [x] `agents/manifest.json` entry (id, label, description, tags, icon).
- [x] Agent defers to docs/support for out-of-scope questions; no invented specifics.
- [x] Added to the pre-publish "docs coherence" verification.
