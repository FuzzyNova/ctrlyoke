# Harness CLI version support

ctrlyoke drives six third-party CLIs that ship roughly weekly and change their
output formats without notice (Copilot 1.0.92 moved its OTel context-window
event from `chat` spans to the `invoke_agent` span, for example). Supporting
every version ever released would mean stacking a new code path on top of
every old one. Instead, each harness has a rolling support window with a single
floor.

## The policy

- **Minimum** (`HarnessConfig.versionPolicy.minimum`): the oldest release in
  the window, roughly the past six months. This is the only version that can
  ever warn a user. A CLI below it is **still launched**: the dashboard shows an
  amber dot and the update command, a workflow that uses it gets a
  `compatibility.harness.belowMinimum` warning when it starts (the same
  diagnostic shows in the editor, preview and `ctrlyoke validate`), and a failed
  step repeats the guidance in its failure message
  (`CliIntegration.getLastFailureReason()`). We never refuse to try a CLI over
  its version.
- **Models never set the minimum.** New models routinely need the latest CLI
  and old ones are retired, so gating on them would move the minimum every
  week. A CLI that rejects a model fails the step with its own error, which
  must reach the user (see `ICliProvider.extractErrorFromStdout` for a
  log-sourced harness whose stdout carries it). Claude and Codex model lists
  are static (`ModelConstants.ts`) and documented as matching `testedWith`; the
  other harnesses discover models from the installed CLI.
- **The minimum is the lowest release where everything ctrlyoke does works**:
  the highest of the rolling-window floor and every required feature's
  introduction version. Because below-minimum only warns, raise it as soon as
  ctrlyoke starts relying on a newer CLI feature for consistent behavior.
- **A CLI at or above the minimum never warns**, however far behind the latest
  release it is. A user who opens a new ctrlyoke without updating their CLIs
  must not see a warning on every harness.
- **Tested with** (`versionPolicy.testedWith`): the release the harness suite
  passed against when this ctrlyoke version was released, normally the latest
  release at that time. Informational: it is published in the compatibility
  docs and never produces a warning.
- **Newer than tested with** is also green. CLIs ship weekly, so most users run
  a release newer than the one we tested within days of a ctrlyoke release.
  When a new CLI release does break something, that is a bug to fix (and
  possibly a reason to raise the minimum), not a state to warn about.
- A CLI whose `--version` output cannot be parsed is `UNKNOWN` and is never
  flagged: a changed banner must not mislead users.
- **Verified versions** (capability `verification.verifiedVersions`) are a
  separate, per-feature evidence record. An installed version outside a
  feature's range raises an "unverified" diagnostic when a workflow uses that
  feature (editor, preview and `ctrlyoke validate`), never a harness-picker
  warning. Keep each range's lower bound at or below `minimum` once that
  feature has been checked at the minimum; a floor above `minimum` warns users
  the version policy calls supported. A range above `minimum` is only right
  for a feature that genuinely needs a newer CLI.

Assessment is single-sourced in `detectHarness()`
(`src/core/harness/shared/HarnessDetection.ts`), which `CliIntegration`,
`IntegrationFactory.detectDefaultHarness()` (the standalone CLI) and
`HarnessCapabilityRegistry` all call. It always reports an installed CLI as
available. Wording is single-sourced in `formatHarnessVersionGuidance()`
(`src/utils/HarnessVersion.ts`), shared by the extension host and the
dashboard.

### Why below-minimum warns but still runs

Code serving older versions is deleted when the minimum moves, so a CLI below
it may break in ways ctrlyoke can no longer work around. Warning (rather than
refusing) keeps a working setup working and puts the likely cause in front of
the user when it does not. The hazard to remember is that a CLI too old to emit
a hook or log format ctrlyoke relies on can stall a step instead of failing it,
so when you raise a minimum because an older version breaks completion
detection, say so in the CHANGELOG.

## When the minimum moves

Move a minimum when either is true:

1. **The window rolls.** Do this early in a development cycle, not in release
   prep, so deleting the legacy code gets a full cycle of testing before it
   ships. Check the new minimum works (install it, run a workflow per harness)
   before committing it.
2. **A CLI release breaks something older versions cannot work around.** Fix it
   in a patch release if needed; raise the minimum only when the fix cannot
   serve the older versions too. Prefer parsing by shape, which avoids both.
3. **ctrlyoke starts relying on a newer CLI feature** (a flag, hook event,
   config key or output field) for consistent behavior. Raise the minimum to
   the release that introduced it, in the same change, and align that
   feature's `verifiedVersions` floor.

To move a minimum:

1. `npm run harness:version-floors` prints each harness's current policy and
   the first npm release inside the window (suggested minimum). Antigravity is
   not on npm, so choose its minimum by hand.
2. Edit each provider's `config.versionPolicy.minimum`.
3. Delete code that only served versions below the new minimums. Version-
   specific fallbacks should say which versions they serve (for example
   `// legacy: Copilot < 1.0.30`) so this step is a search, not an
   archaeology project.
4. `npm run generate-compatibility-docs`, and note the new minimums under
   **Changed** in `CHANGELOG.md`.

## Before each ctrlyoke release: refresh `testedWith`

Because `testedWith` never warns, moving it to the newest CLIs costs users
nothing, so it is done as late as possible:

1. Update every harness CLI on the release machine (CHORES.md, chore 1).
2. Run `npm run test:harness` once (it costs money and takes 30+ minutes). It
   must pass.
3. `npm run harness:version-floors` shows the installed version beside each
   `testedWith`. Set each provider's `versionPolicy.testedWith` to the installed
   version the suite just passed against.
4. `npm run generate-compatibility-docs` and commit before the version bump.

If a new CLI release fails the suite, either fix it in this release or roll
that CLI back to its previous `testedWith` and keep that value. Never record a
`testedWith` the suite has not passed against.

## Writing parsers that survive format changes

Prefer parsing by shape over branching by version: accept the data wherever it
appears, as `CopilotLogParser.pollOtelContextWindow()` does for `usage_info`
events on either span. That needs no version check, and therefore no cleanup
when the floor moves. Add a version-gated branch only when two versions emit
genuinely conflicting data for the same input.
