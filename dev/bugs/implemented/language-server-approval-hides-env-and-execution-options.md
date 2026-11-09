# Workspace language server approval hides the environment and execution options it approves

- **Found:** 2026-11-09 by bug-hunt final step (pass 26), claude-cli
- **Area:** `src/server/lsp/ManagedLanguageServerBackend.ts`
- **Resolution:** fixed in this commit

## Symptom

A workspace `.ctrlyoke/settings.json` can define a language server under
`languageServers.definitions`. Workspace definitions run only after the user
approves them in the "Approve workspace language servers" prompt. That prompt
shows one line per server, `<id>: <command joined by spaces>`, and nothing
else. The approval also covers values the user never sees:

- `definition.env`, which is merged into the server's environment
  (`const env = { ...process.env, ...resolved.env }` in
  `ManagedLanguageServerBackend`, around line 879).
- The server's workspace `languageServers.settings[id]` entries whose keys look
  executable (`path|tsdk|plugin|command|env|exec|executable|binary`, per
  `getWorkspaceExecutionOptionEntries` in
  `src/server/lsp/LanguageServerResolver.ts`). These are kept only for an
  approved definition (`stripUnapprovedWorkspaceOptions`).

Both go into the approval hash (`definitionHash`), so the user's "allow"
covers them, but the prompt doesn't show them. For example, this shows as the
harmless `ts: typescript-language-server --stdio`:

```json
{
  "languageServers": {
    "definitions": {
      "ts": {
        "command": ["typescript-language-server", "--stdio"],
        "languages": ["typescript"],
        "extensions": [".ts"],
        "rootMarkers": [],
        "env": { "NODE_OPTIONS": "--require ./.ctrlyoke/x.js" }
      }
    }
  }
}
```

Once allowed, the server starts and Node loads the workspace's `x.js`. On macOS
or Linux, `DYLD_INSERT_LIBRARIES`/`LD_PRELOAD` would work the same way for a
native server. Joining `command` with spaces also hides argument boundaries:
`["node", "a b.js"]` and `["node", "a", "b.js"]` show the same text.

This is the same flaw ~58d6c26 fixed for the workspace-settings trust prompt,
which gained a `detail` field on `BatchApprovalItem`. The language server
prompt uses the same `requestBatchApproval` and modal, but it was never updated
to pass a detail.

## Steps to Reproduce

1. Add the definition above to a workspace's `.ctrlyoke/settings.json`.
2. Open a `.ts` file in the workspace viewer so the server is resolved.
3. The approval modal lists only `ts: typescript-language-server --stdio`.
4. Read `approveWorkspaceDefinitions` in `ManagedLanguageServerBackend.ts`: the
   item has `value` and `label` only (`label: \`${id}: ${definition.command.join(" ")}\``).

## Root Cause

`ManagedLanguageServerBackend.approveWorkspaceDefinitions` builds each
`BatchApprovalItem` without a `detail`, and its label renders `command` only.
The hash it records covers `command`, `env`, `initializationOptions` and
execution options.

## Suggested Fix

Pass a `detail` for each pending definition, rendered from exactly what
`definitionHash` covers. Show the command as a JSON array (or one quoted
argument per line) so argument boundaries are visible, every `env` entry, and
the execution-option entries from `getWorkspaceExecutionOptionEntries` for that
server's workspace settings. `BatchApprovalModal` already renders `detail` in
full (~58d6c26). If the shared control-character escaping helper from
`dev/bugs/backlog/cli-trust-prompts-print-raw-control-characters.md` has landed
by then, apply it to this detail too. Add a test in
`src/test/unit/ManagedLanguageServerBackend.test.ts` (or the nearest existing
LSP backend test) asserting that the approval request's item detail includes
the env key/value and an execution option. Keep the approval hash unchanged so
existing approvals stay valid.
