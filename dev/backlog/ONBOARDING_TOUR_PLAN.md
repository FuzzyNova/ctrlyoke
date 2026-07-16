# New-User Onboarding & Tour

**Created:** July 4, 2026
**Status:** Phase 1 IMPLEMENTED; Phase 2 deferred/likely unnecessary
**Priority:** **Phase 1 = v0.1.0 BLOCKER; Phase 2 deferred/likely unnecessary** (Nathan, July 4, 2026)
**Effort:** Minimal path 2–3 days; full interactive tour 1–2 weeks
**Related:** [`BUILTIN_TECH_SUPPORT_AGENT_PLAN.md`](../implemented/BUILTIN_TECH_SUPPORT_AGENT_PLAN.md), [`HARNESS_PREFLIGHT_PLAN.md`](HARNESS_PREFLIGHT_PLAN.md), [`BUILTIN_AGENTS_TEMPLATES_CLEANUP_PLAN.md`](../implemented/BUILTIN_AGENTS_TEMPLATES_CLEANUP_PLAN.md)

---

## Background

ctrlyoke is dense — harnesses, workflows, steps, end conditions, sessions, context
references, the dashboard. A first-time user who installs from the Marketplace opens
the dashboard cold with no guidance. First impressions drive Marketplace retention
and reviews, so onboarding is a launch-quality concern, not just polish.

## Goal

Guide a brand-new user from install → first successful workflow with minimal friction,
highlighting the common controls along the way.

### Scope options (phased)

**Phase 1 — Minimal onboarding (achievable for v0.1.0):**

- **VS Code Walkthrough** via `contributes.walkthroughs` in `package.json` — the native
  onboarding surface VS Code shows after install (Getting Started page). Steps: pick/
  verify a harness (ties into [`HARNESS_PREFLIGHT_PLAN.md`](HARNESS_PREFLIGHT_PLAN.md)),
  create a workflow from a template, run it, read the output. Low effort, native, dismissible.
- **Dashboard empty state** — when no workflows exist, show a getting-started panel
  ("Create from template", "Ask the ctrlyoke-tech-support agent", link to docs) instead
  of a blank pane.
- **"Ask ctrlyoke" entry point** — surface the tech-support agent
  ([`BUILTIN_TECH_SUPPORT_AGENT_PLAN.md`](BUILTIN_TECH_SUPPORT_AGENT_PLAN.md)) as the
  in-product help path.

**Phase 2 — Interactive tour (post-launch):**

- A guided, step-through overlay that highlights the actual dashboard controls (run/
  pause/resume, harness dropdown, properties drawer, output/history, context pickers).
  Higher effort (webview overlay, anchor targeting, dismiss/replay state). Nice, but not
  required for launch.

## Design notes

- Prefer the **native VS Code Walkthrough** for Phase 1 — it is standard, discoverable,
  and low-maintenance versus a bespoke webview coach-mark system.
- Persist "onboarding seen/dismissed" so it does not nag returning users.
- Add a "Show ctrlyoke Getting Started" command so users can reopen it.
- Keep copy in sync with the tech-support agent and docs (single-source the key facts).

## Should this block release?

**Decision (Nathan, July 4, 2026):**

- **Phase 1 (native VS Code Getting Started walkthrough + empty state) — v0.1.0 BLOCKER.**
  Plugging into the standard post-install Getting Started page that most extensions use,
  paired with strong screenshots/GIF, is the launch's first-impression story.
- **Phase 2 (interactive tour) — DEFERRED, and possibly unnecessary.** Nathan's view: if
  the native Getting Started page + good screenshots/GIF land well, a bespoke interactive
  tour may never be needed. Re-evaluate after Phase 1; do not build speculatively.

## Acceptance (Phase 1)

- [x] `contributes.walkthroughs` added with 3–5 steps ending in a successful run.
- [x] Dashboard shows a getting-started empty state when no workflows exist.
- [x] Onboarding is dismissible and reopenable via a command; "seen" state persists.
- [x] Copy points to the tech-support agent and `ctrlyoke.dev/docs`.

## Implementation notes (Phase 1)

- Walkthrough: `package.json` `contributes.walkthroughs` (`ctrlyoke.gettingStarted`),
  step content in `walkthroughs/getting-started/*.md`. Steps use `onView`/`onCommand`
  completion events against existing commands (`ctrlyoke.openPanel`,
  `ctrlyoke.newWorkflow`, `ctrlyoke.run`) — no new completion plumbing needed.
- First-run auto-open + reopen: `src/extension.ts` (`GETTING_STARTED_SHOWN_KEY`
  globalState flag, `ctrlyoke.showGettingStarted` command).
- Dashboard empty state: `WorkflowStepsPanel.tsx`'s existing `steps.length === 0`
  branch, not a new App-level panel — it's the actual "no workflow" signal already
  used in the codebase.
- Screenshots/GIF for the walkthrough steps are intentionally deferred — see
  `RELEASE_PLAN.md` §4 (captured last, after onboarding UI is final).
