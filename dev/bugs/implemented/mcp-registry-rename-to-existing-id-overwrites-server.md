# Renaming an MCP registry server to an existing id silently overwrites the other server

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/McpManagerService.ts`
- **Resolution:** fixed in this commit

## Symptom

If you edit an MCP registry server in the dashboard's MCP manager and change its id to one another server already uses, that other server's config is silently overwritten and lost. The edited server's old entry is removed. No warning or error is shown.

## Steps to Reproduce

1. In Settings > MCP manager, in one scope (user or workspace), add two servers, e.g. `github` (command A, env X) and `gh-old` (command B, env Y).
2. Click edit on `gh-old`, change its id field to `github`, and click save.
3. Look at the registry list or the registry JSON file. Only one `github` entry is left, and it holds gh-old's command B and env Y. The original `github` config (command A, env X) is gone, and no error was shown.

## Root Cause

- `src/ui/McpManagerService.ts:128-131`: on a rename (`previousId !== server.id`), `handleSaveRegistryServer` calls `manager.remove(previousId)` and then `manager.addOrUpdate(server)` without checking whether `server.id` already exists in that scope.
- `src/utils/McpRegistryFileManager.ts:320-325`: `addOrUpdate` finds an existing entry with the same id and replaces it (`next[existingIndex] = server`), so the other server is overwritten.
- The client does not catch it either: `isMcpServerFormValid` in `src/ui/webview-react/components/shared/McpServerForm.tsx:161-167` only checks for a non-empty id, and `handleSaveEdit` in `src/ui/webview-react/components/settings/McpManagerSection.tsx:694-697` does no duplicate check.
- The rename is also not atomic. `remove` (`McpRegistryFileManager.ts:337-344`) and `addOrUpdate` run as two separate serialized mutations, so if `addOrUpdate` throws after `remove` succeeded (invalid config, write failure), the original entry is deleted and nothing replaces it.

## Suggested Fix

Add a single atomic rename operation to `McpRegistryFileManager`, e.g. `rename(previousId, server, scope)`. Inside one `serializeMutation`, it reads the array, rejects the save with an error if another entry (not `previousId`) already has `server.id`, replaces the `previousId` entry in place (keeping its position), and writes once. Have `handleSaveRegistryServer` call it when `previousId` differs.

Optionally, also reject a new add whose id is already taken, and show an inline duplicate-id error in `McpServerForm`/`McpManagerSection` (the registry server list is already in the store).

Add tests in `src/test` for a rename collision being rejected and for a rename leaving the registry unchanged when the write fails.
