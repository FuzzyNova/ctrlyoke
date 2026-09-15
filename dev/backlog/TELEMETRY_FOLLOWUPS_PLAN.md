# Telemetry Follow-ups

**Created:** September 15, 2026
**Status:** Proposed.
**Builds on:** [`../implemented/TELEMETRY_PLAN.md`](../implemented/TELEMETRY_PLAN.md) (IMPLEMENTED — reporter singleton, all five events, README disclosure).

The telemetry foundation is fully implemented and verified against the code.
This doc tracks the deliberately-deferred remainder so it doesn't get lost.

---

## 1. Wire token usage into `prompt/completed`

`reportPromptCompleted` (`src/utils/TelemetryEvents.ts`) does not carry
`inputTokens`/`outputTokens`/`cachedInputTokens`. The call site,
`PromptQueue.markPromptCompleted()` (`src/core/PromptQueue.ts:1368`), only has
`PromptRuntimeMetadata` in scope — no per-step `TokenUsage` — so adding these
fields means either threading `TokenUsage` into that metadata or reaching into
the usage-tracking services from `PromptQueue`, both larger and riskier than
the original telemetry pass. Still not wired as of 2026-09-15.

## 2. Generic command-handler error telemetry

`src/extension.ts` has roughly seven scattered
`vscode.commands.registerCommand(...).catch((error) => { ... })` blocks
(distinct from the top-level `activate()` catch, which already reports
`extension/activationFailed`) with no telemetry. Wrapping all of them
uniformly is a separate, larger refactor than the original event-wiring pass
and was deliberately deferred, not forgotten.

## 3. Optional `telemetry.json`

VS Code supports an optional `telemetry.json` file at the extension root that
lets users dump declared telemetry events via the `--telemetry` CLI flag (see
https://code.visualstudio.com/api/extension-guides/telemetry). Not yet added;
low priority since the real events now exist and are stable enough to
document this way.

## 4. Pre-ship QA gate: confirm events reach Application Insights

Before the next release that ships telemetry-visible code, manually trigger
each of the five events (`workflow/started`, `workflow/completed`,
`prompt/completed`, `endcondition/evaluated`, `cli/not_found`, plus
`extension/activationFailed`) against the real dev Application Insights
resource and confirm they appear in Live Metrics. This is a manual step that
cannot be verified from the repo — track it as a checklist item on the next
release, not as dead backlog.
