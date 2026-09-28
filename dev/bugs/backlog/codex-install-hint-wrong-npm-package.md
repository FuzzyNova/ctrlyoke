# Codex CLI install hint names the wrong npm package

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/harness/codex/CodexCliProvider.ts`
- **Severity:** low

## Symptom

When the Codex CLI is not installed, ctrlyoke's in-product "unavailable" message tells the user to
run `npm install -g @openai/codex-cli`. The Codex CLI is published as `@openai/codex`, which is
what `docs/harnesses/codex-cli.md:15` and `scripts/chores.mjs` use. Following the in-product hint
does not install Codex. `docs/troubleshooting/common-errors.md` points users at exactly this
message.

## Steps to Reproduce

1. On a machine without `codex` on `PATH`, select the `codex-cli` harness in the dashboard or run
   the CLI with `--harness codex-cli`.
2. The unavailable message says `Install via: npm install -g @openai/codex-cli`.

## Root Cause

`CodexCliProvider.ts:190` has `installHint: "Install via: npm install -g @openai/codex-cli"`. The
tests `src/test/unit/WebviewSettingsSync.test.ts` and `src/test/unit/CtrlYokeHostedServer.test.ts`
hard-code the same wrong string.

## Suggested Fix

Change the hint to `npm install -g @openai/codex` and update both tests. Where practical, have the
tests reference the provider's hint (or a shared constant) instead of repeating the literal. Check
the other providers' `installHint` values against their docs pages at the same time.
