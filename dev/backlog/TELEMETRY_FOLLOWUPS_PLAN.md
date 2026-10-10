# Telemetry Follow-ups

**Created:** September 15, 2026
**Status:** Proposed (none of the four items done).
**Builds on:** [`../implemented/TELEMETRY_PLAN.md`](../implemented/TELEMETRY_PLAN.md) (IMPLEMENTED — reporter singleton, all five events, README disclosure).

> **2026-10-10 audit:** Re-verified against the code. Nothing here has landed:
> `reportPromptCompleted` still has no token fields, there is no
> `telemetry.json`, and the `registerCommands` handlers in `src/extension.ts`
> still don't report telemetry. Fixed a stale line reference and
> corrected item 2's description of the catch blocks. Token counts already fit
> PRIVACY.md §3.1's "counts and durations" bullet, so item 1 doesn't need a
> privacy-policy change.

The telemetry foundation is fully implemented and verified against the code.
This doc tracks the deliberately-deferred remainder so it doesn't get lost.

---

## 1. Wire token usage into `prompt/completed`

`reportPromptCompleted` (`src/utils/TelemetryEvents.ts`) does not carry
`inputTokens`/`outputTokens`/`cachedInputTokens`. The call site,
`PromptQueue.markPromptCompleted()` (`src/core/PromptQueue.ts`, ~line 1414), only has
`PromptRuntimeMetadata` in scope — no per-step `TokenUsage` — so adding these
fields means either threading `TokenUsage` into that metadata or reaching into
the usage-tracking services from `PromptQueue`, both larger and riskier than
the original telemetry pass. Still not wired as of 2026-10-10.

## 2. Generic command-handler error telemetry

Command handlers in `registerCommands()` in `src/extension.ts` have about a
dozen separate `try { ... } catch (error) { ... }` blocks that only log or show
an error message. They are separate from the top-level `activate()` catch, which
already reports `extension/activationFailed`, and none of them send telemetry.
`src/ui/CtrlyokeCliCommands.ts` and `src/ui/NativeOutputCaptureCommand.ts` also
register commands. Wrapping all of them
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
