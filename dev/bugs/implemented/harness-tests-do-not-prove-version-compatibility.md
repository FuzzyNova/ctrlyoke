# `test:harness` does not prove the compatibility claims or the minimum versions

- **Found:** 2026-10-21 by Claude (harness version-support review)
- **Area:** `src/test/harness/**`, every provider's capability declarations and `config.versionPolicy`
- **Resolution:** fixed in this commit. `capabilities.harness.test.ts` runs one case per published
  claim, generated from the registry, and declarations it proves now cite it; the suite records
  the CLI versions it ran in a version report; `npm run test:harness:minimum` runs it against the
  npm minimums. Claims it shows broken are filed separately (`KNOWN_BROKEN_CLAIMS` in
  `src/test/harness/capabilityEvidence.ts`).

## Symptom

The compatibility matrix and the `minimum` / `testedWith` versions are published as facts, but
`npm run test:harness` checks only part of them, and only against whatever CLIs are installed:

- Most capability `verification` entries are `kind: "manual"`, pointing at a docs page or at the
  ctrlyoke source file that implements the feature. The suite has no case for them.
- `inline-config.harness.test.ts` pins Codex 0.146.0, OpenCode 1.18.10 and Qwen 0.20.1 in
  comments only; nothing checks which version actually ran. Those pins were later mistaken for
  feature-introduction versions.
- Nothing runs the suite at the `minimum` versions. The October 2026 research found the old Codex
  minimum (0.119.0) failed every step at startup and Qwen's (0.14.1) failed every MCP step.
- Several matrix claims are wrong in ways a harness case would have caught:
  - OpenCode MCP deny rules never match (`opencode-mcp-tool-deny-rules-never-match.md`).
  - The OpenCode `permissionRequest` hook never fires (`opencode-permission-request-hook-never-fires.md`).
  - Qwen API errors are reported as success (`qwen-api-errors-reported-as-success.md`).

## Steps to Reproduce

1. Compare each `exact`/`partial` declaration in the six providers with the cases listed by
   `src/test/harness/*.test.ts` (conditions, hooks, inline-config, MCP probe, MCP queue, workflow).
2. Images, permissions per harness, per-server MCP filtering on most harnesses, each hook event,
   resume and model-error reporting have no harness case.

## Root Cause

The harness suite grew per feature, with no rule tying each published capability to a test, and it
has no way to run against chosen CLI versions.

## Suggested Fix

**1. One case per published claim.** For each harness, cover at least:

- Every hook event declared supported fires: `sessionStart`, `stop`, `preToolUse`, `postToolUse`,
  `userPromptSubmit`, `permissionRequest`, `notification`, `error`.
- Permission modes, plus an allowed and a denied tool pattern, actually enforced.
- MCP: server attached, tool called, a per-server denied tool refused.
- An image reference reaches the model (ask it for a word printed in a fixture PNG).
- Headless and interactive completion, and resume of the previous step's session.
- An unknown `--model` (via `model: none` + `additionalArgs`) fails the step with the CLI's own
  message. This is free: the request is rejected before any tokens are used. A Codex bug of this
  kind was fixed while filing this doc, and Qwen still has one.

Then switch each covered declaration to `kind: "behavioral-test"` referencing its case. A unit test
can require that every non-`unsupported` declaration's reference is a `src/test/harness/` file,
except for an explicit allowlist.

**2. Record the version that ran.** Have `harnessRunner.ts` log, or assert, each CLI's
`--version` at suite start. Write a summary (harness → version → pass/fail) under
`.ctrlyoke/logs/test-runs/`, so setting `testedWith` is copying from a file.

**3. A minimum-version mode, without a sandbox.** Windows Sandbox (as in the clean-install
`ctrlyoke-clean.wsb`) resets on close, so each run needs a fresh sign-in to all six CLIs. Instead,
ctrlyoke finds CLIs through `PATH` (`CliLauncherResolver` uses `Get-Command`), so:

- `scripts/install-harness-minimums.mjs` installs each npm harness at its `versionPolicy.minimum`
  into a gitignored prefix such as `.ctrlyoke/harness-minimums/` (`npm install --prefix … pkg@ver`).
- `npm run test:harness:minimum` runs the suite with that prefix's bin directory first on `PATH`.
  It keeps the developer's existing sign-ins in `~/.copilot`, `~/.claude`, `~/.codex`, `~/.qwen`
  and opencode's config directory.
- Turn off self-update for that run: ctrlyoke already passes Copilot `--no-auto-update` and Codex
  `check_for_update_on_startup=false`; also set `DISABLE_AUTOUPDATER=1` for Claude.
- Antigravity is not on npm. Check whether `agy` can install a specific version; otherwise test its
  minimum by hand and note it in `HARNESS_VERSION_SUPPORT.md`.
- Risk: an old CLI reading config written by a newer one. Back up `~/.codex/config.toml` and
  `~/.qwen/settings.json` before a run, or point `CODEX_HOME` at a copy.

Run it once whenever a minimum moves, and record the result in the CHANGELOG entry.
