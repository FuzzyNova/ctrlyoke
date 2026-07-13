# Harness Preflight & Install Guidance

**Created:** July 4, 2026
**Status:** PLANNING
**Priority:** **v0.1.0 BLOCKER** (confirmed by Nathan, July 4, 2026)
**Effort:** 2–4 days
**Related:** [`ONBOARDING_TOUR_PLAN.md`](ONBOARDING_TOUR_PLAN.md)

---

## Background (a gap not previously in the backlog)

ctrlyoke drives **external** AI CLIs (Copilot, Claude, Codex, OpenCode, Qwen,
Antigravity). None of them are bundled — the user must install the CLI separately and
authenticate it. A brand-new user who installs the extension but has **no harness CLI
installed** currently only discovers the problem by creating a workflow, running it,
and hitting a failure. The `installHint` strings exist per provider
(`ClaudeCliProvider` etc.) but are only surfaced as a **runtime error message** at
execution time (`CliIntegration.ts` `❌ <harness> unavailable - <installHint>`), and
availability is reflected in the harness dropdown — there is **no proactive first-run
preflight** that tells the user "you have no usable harness; here's how to install one."

For a tool whose entire value depends on an external CLI being present and
authenticated, "install and it silently does nothing until you fail a run" is a rough
first-run story.

## Goal

Detect harness availability up front and guide the user to a working state before they
run anything.

### Scope

- **First-run preflight:** on activation / first dashboard open, check whether _any_
  supported harness CLI is available (reuse `CliProviderUtils.checkCliAvailability` +
  the provider `config.installHint`). If none are, show a clear, actionable panel:
  which CLIs are supported, the install command for each (`installHint`), and an auth
  reminder.
- **Per-harness status in the picker:** ensure the harness dropdown clearly marks
  unavailable harnesses and shows the install hint on hover/selection (partly present —
  verify and polish).
- **Actionable run-time error:** keep the existing execution-time error, but make sure
  it points at the same install/auth guidance rather than a bare string.
- **Auth vs. installed distinction (stretch):** "installed but not logged in" is a
  different failure than "not installed." Detect/communicate separately if feasible;
  otherwise link to each CLI's auth docs.

## Design notes

- Reuse existing detection — this is a **surfacing/UX** problem, not new detection logic.
- Tie the preflight into onboarding ([`ONBOARDING_TOUR_PLAN.md`](ONBOARDING_TOUR_PLAN.md)):
  "verify a harness" is the natural first walkthrough step.
- Do not hard-block usage (the user may be mid-install); inform and link, don't gate.

## Should this block release?

**Decision: YES — v0.1.0 blocker** (Nathan, July 4, 2026). It is arguably the single
biggest new-user cliff: without it the tool appears inert until a run fails. The minimal
preflight (the "no harness available" panel + picker guidance) ships in v0.1.0. The
auth-vs-installed distinction stretch remains fast-follow. Tracked in `RELEASE_PLAN.md` §2.9.

## Acceptance

- [ ] First-run/activation detects when no supported harness CLI is available.
- [ ] Clear panel lists supported harnesses + install commands (`installHint`) + auth reminder.
- [ ] Harness picker marks unavailable harnesses with the install hint.
- [ ] Execution-time "unavailable" error links to the same guidance.
