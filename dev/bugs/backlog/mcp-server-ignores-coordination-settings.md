# MCP server ignores every `coordination.*` setting

- **Found:** 2026-10-14 by Claude (writing `docs/workflows/coordination.md`)
- **Area:** `src/mcp-server.ts`, `src/core/orchestration/ExecutionRootCoordination*.ts`
- **Severity:** medium

## Symptom

Changing any `coordination.*` setting in `.ctrlyoke/settings.json` (user or workspace scope)
has no effect on calls made through ctrlyoke's MCP server, which is where almost every board
write comes from. In particular:

- `coordination.allowExternalParticipants: false` does not stop an external MCP client from
  joining the board, posting notes or claiming paths. External participants can only arrive
  through the MCP server, so the setting is effectively dead.
- `maxNoteLength`, `readNotesPageSize`, `maxEntries`, `maxBoardBytes`, `maxEntryAgeDays` and
  `cliParticipantTtlMinutes` always use their built-in defaults for `post_note`, `read_notes`,
  `claim_paths` and `release_paths`, in both stdio mode and one-shot `--tool` (skill) mode.

The extension process does read the settings, so the few board writes it makes (closing a
settled step's participant, releasing a group's claims at the join) and the dashboard's
Coordination panel use the configured values. The board is therefore compacted with different
caps depending on which process appends.

## Steps to Reproduce

1. Set `"coordination": { "allowExternalParticipants": false }` in `.ctrlyoke/settings.json`.
2. From the checkout, run
   `node out/mcp-server.js --tool post_note --args '{"text":"hi"}'` (no `--working-file`).
3. The note is posted and a `seq` is returned. Expected: "External coordination participants
   are disabled".

Likewise set `maxNoteLength` to `10` and post a longer note through a workflow step: it is
accepted.

## Root Cause

`configService` returns `CTRLYOKE_SETTINGS_DEFAULTS` when no backend is set
(`CtrlYokeConfigService.getAll()`). The extension, the CLI and `ctrlyoke server` call
`setUserBackend`/`setWorkspaceBackend`, but `src/mcp-server.ts` never does: neither the stdio
entry (`initializeMcpStorage().then(() => new CtrlYokeMCPServer().start())`) nor
`runMcpToolCli` configures a backend. `CoordinationParticipantRegistry.register()`
(`ExecutionRootCoordination.ts`, the `allowExternalParticipants` check),
`getCliParticipantTtlMinutes()`, and `retentionOptions()` in
`ExecutionRootCoordinationStore.ts` all read `configService.get("coordination")`, so in the
MCP server process they always see defaults. No test covers enforcement of these settings
from the MCP server.

## Suggested Fix

Configure the user and workspace settings backends in `initializeMcpStorage()` (the workspace
backend rooted at the state root `CTRLYOKE_WORKSPACE`, as the CLI does), so both the stdio
server and `--tool` mode read the same settings as the extension. Add a test that sets
`allowExternalParticipants: false` and `maxNoteLength` through settings files and asserts the
MCP server enforces them.
