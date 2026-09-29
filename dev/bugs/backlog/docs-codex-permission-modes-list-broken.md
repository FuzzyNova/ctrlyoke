# Codex harness docs: permission mode list is malformed and omits `none`; `server.standalonePort` is advertised but unused

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `docs/harnesses/codex-cli.md`, `schemas/settings-schema.json`
- **Severity:** low

## Symptom

1. `docs/harnesses/codex-cli.md` line 19: the `custom` bullet runs straight into the next item
   (`... -a <permissions.codexApprovalPolicy>`- `permissions.codexSandboxMode` ...). The
   sandbox/approval defaults paragraph therefore renders glued onto the `custom` line. The mode
   mapping also leaves out `none`: `CodexToolPermissionMapper.ts` (around lines 177-178) returns
   no flags for it, so Codex uses its own defaults.
2. `server.standalonePort` is in `schemas/settings-schema.json` (around lines 820-826),
   `src/types/CtrlYokeSettings.ts` (lines 297 and 572) and the generated
   `docs/reference/settings.md`, described as "Port for the standalone (non-extension) ctrlyoke
   server". Nothing in `src/` reads it. The only server is `CtrlYokeHostedServer`, which uses
   `server.port` (`src/extension.ts` around line 1430), and no CLI command starts a standalone
   server. A user who sets it gets no listener and no warning.

## Steps to Reproduce

1. View `docs/harnesses/codex-cli.md` lines 15-20.
2. `grep -rn standalonePort src --include=*.ts` returns only the type, the default and the
   generated description.

## Suggested Fix

1. Put the `permissions.codexSandboxMode` sentence on its own bullet line. After checking the
   mapper, add ``- `none` → no permission flags (Codex's own defaults)``.
2. Remove `server.standalonePort` from the schema, the settings type and the defaults, then run
   `npm run generate-schema-docs` and `npm run generate-schema`. The project is pre-release, so no
   compatibility shim is needed. Fix any test that pins it.
