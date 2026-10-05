# Harness CLI version support

ctrlyoke drives six third-party CLIs that ship roughly weekly and change their
output formats without notice (Copilot 1.0.92 moved its OTel context-window
event from `chat` spans to the `invoke_agent` span, for example). Supporting
every version ever released would mean stacking a new code path on top of
every old one. Instead, each harness has a rolling support window.

## The policy

- **Supported:** releases published in roughly the past six months, measured at
  each ctrlyoke release. Customer-facing wording lives in the generated
  "Supported versions" section of `docs/harnesses/compatibility.md`.
- **Minimum** (`HarnessConfig.versionPolicy.minimum`): the oldest supported
  release. An older CLI is reported unavailable and every surface shows its
  `updateCommand` instead of running it.
- **Recommended** (`versionPolicy.recommended`): the release this ctrlyoke
  version was verified against. An older CLI still runs; the harness picker
  shows a warning dot and the tooltip carries the update command.
- A CLI whose `--version` output cannot be parsed is `UNKNOWN` and is never
  blocked: a changed banner must not lock users out.

Enforcement is single-sourced in `detectHarness()`
(`src/core/harness/shared/HarnessDetection.ts`), which `CliIntegration`,
`IntegrationFactory.detectDefaultHarness()` (the standalone CLI) and
`HarnessCapabilityRegistry` all call. Wording is single-sourced in
`formatHarnessVersionGuidance()` (`src/utils/HarnessVersion.ts`), shared by the
extension host and the dashboard.

## At each ctrlyoke release

1. Update every harness CLI on the release machine, run the suite, and verify
   the harnesses (`npm run test:harness` costs money; run it deliberately).
2. `npm run harness:version-floors` prints each harness's current policy, the
   first npm release inside the window (suggested minimum), and the installed
   version (candidate recommended). Antigravity is not on npm, so choose its
   minimum by hand.
3. Edit each provider's `config.versionPolicy`.
4. Delete code that only served versions below the new minimums. Version-
   specific fallbacks should say which versions they serve (for example
   `// legacy: Copilot < 1.0.30`) so this step is a search, not an
   archaeology project.
5. `npm run generate-compatibility-docs` to refresh the published table.

## Writing parsers that survive format changes

Prefer parsing by shape over branching by version: accept the data wherever it
appears, as `CopilotLogParser.pollOtelContextWindow()` does for `usage_info`
events on either span. That needs no version check, and therefore no cleanup
when the floor moves. Add a version-gated branch only when two versions emit
genuinely conflicting data for the same input.
