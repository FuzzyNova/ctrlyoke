# CLI docs claim no network requests or license checks, but `ctrlyoke server` does both

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (docs vs. code audit)
- **Area:** `docs/guide/privacy.md`, `docs/cli/index.md`, `docs/cli/ctrlyoke.md`, `docs/cli/ctrlyoke-mcp.md`
- **Severity:** low

## Symptom

The privacy and CLI pages make absolute claims that `ctrlyoke server` breaks:

- @docs/guide/privacy.md (lines 32-33) and @docs/cli/index.md (lines 77-78)
  say the CLI and `ctrlyoke-mcp` "make no network requests of their own".
- @docs/cli/index.md (line 75) says "The CLI does not check a license".
  @docs/cli/server.md describes the Pro remote-access gate, so the two pages
  contradict each other.

What the code actually does:

- `ctrlyoke server` builds a `LicenseService` and calls
  `void licenseService.refresh()` (#selection:src/platform/NodeHostServices.ts:123-125).
  With an online Pro license cached, that can contact Keygen.
- `ServerCommand` checks `hasRemoteAccess()` before generating LAN HTTPS
  certificates (#selection:src/cli/ServerCommand.ts:158-167).
- With push notifications enabled, the hosted server sends web-push requests
  (`src/server/WebPushService.ts`, `fetch(endpoint, …)`).

Smaller inaccuracies found in the same pass:

- `docs/cli/ctrlyoke-mcp.md` (~line 139) says only `global_status` and the
  coordination tools work without an attached run. `submit_commit_message` also
  does (`RUNLESS_TOOL_NAMES` in `src/mcp-server.ts`).
  `docs/reference/mcp-tools.md` already gets this right.
- `docs/cli/ctrlyoke.md` (~line 157) says a condition's own `timeoutSec` "still
  wins" over `--script-timeout`. `--force script-timeout` overrides it
  (`src/cli/CliPropertyOverrides.ts`). The `--force` row (~line 143) doesn't
  list `script-timeout` as a valid flag either, though `--help` does.
- The synopsis at `docs/cli/ctrlyoke.md:12` shows `[--strict <policy>]`, but
  the option is `--strict [policy]` and bare `--strict` works.

## Steps to Reproduce

1. Read the cited doc lines.
2. Compare them with the cited code.

## Root Cause

The docs were written for the headless `run`/MCP case and never updated when
`ctrlyoke server` gained license-gated remote access and push notifications.

## Suggested Fix

Scope the "no network requests" and "no license check" claims to the commands
they hold for (everything except `ctrlyoke server`). Then say what
`ctrlyoke server` contacts: a Keygen license refresh when an online Pro license
is cached, and browser push services when push notifications are on. Link to
the existing "Other network requests" table in the privacy guide. Fix the three
smaller inaccuracies above. Don't hand-edit generated reference pages.
