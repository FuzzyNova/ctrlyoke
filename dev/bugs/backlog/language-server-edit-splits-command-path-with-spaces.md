# Editing a language server definition splits a command path that contains spaces

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/settings/LanguageServersSection.tsx`
- **Severity:** medium

## Symptom

Editing any field of a managed language server definition silently rewrites its command argv if any argument contains whitespace. For example, `["C:\\Program Files\\nodejs\\node.exe", "server.js", "--stdio"]` becomes `["C:\\Program", "Files\\nodejs\\node.exe", "server.js", "--stdio"]`. After that the server no longer resolves or launches, and the broken argv is also exported to harness LSP configs.

## Steps to Reproduce

1. In `.ctrlyoke/settings.json`, add a managed language server definition with command `["C:\\Program Files\\nodejs\\node.exe", "server.js", "--stdio"]` (or import one from a harness config that uses such a path).
2. Open the dashboard Settings > Language Servers, find that row and click Edit.
3. Change only the extensions field (for example, add `, mjs`) and click Save.
4. Inspect `settings.json`: command is now `["C:\\Program", "Files\\nodejs\\node.exe", "server.js", "--stdio"]`. The row probe shows the executable as not found and the server fails to start.

## Root Cause

The argv array goes through a lossy string round-trip. `LanguageServersSection.tsx:471-472` fills the edit form with `definition.command.join(" ")`, and `saveForm` at line 155 parses it back with `form.command.trim().split(/\s+/)`. Neither direction quotes or escapes, so an element containing whitespace cannot survive, even when the user never touched the command field.

Every consumer treats the array as a literal argv:

- `src/server/lsp/LanguageServerResolver.ts:208` (`const [executable, ...args] = definition.command`)
- `src/ui/LanguageServerManagerService.ts:497` (`executablePath(entry.command[0]!, dirs)`)
- `src/utils/HarnessLspExporter.ts:113-114` (`command[0]` / `command.slice(1)`)

## Suggested Fix

Make the conversion lossless. Options:

- Add a shared helper pair (e.g. `formatArgv`/`parseArgv` in a webview utils module) that quotes elements containing whitespace or quotes when serializing and parses with quote awareness when saving. Use it at line 472, line 155, and the display at line 531.
- Or edit the command as a list, one argument per line, the way `env` is edited in a textarea.

In either case, when the command field was not modified, keep the original array instead of re-parsing it. Add a Vitest case that edits a definition whose command contains a spaced path and asserts the saved command is unchanged.
