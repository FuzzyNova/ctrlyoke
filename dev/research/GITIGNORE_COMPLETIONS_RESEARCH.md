# Gitignore-Aware Completions

**Status**: IMPLEMENTED  
**Implemented**: ~2026-01-31  
**Last Verified**: 2026-02-25

---

## Overview

FlightPath completions (`@file` and `#file:` triggers) can filter out gitignored files using the VS Code Git Extension API. This is controlled by the `flightpath.respectGitignoreForCompletions` setting (default: `true`).

---

## Setting

`package.json` (`contributes.configuration.properties`):

```json
"flightpath.respectGitignoreForCompletions": {
  "type": "boolean",
  "default": true,
  "description": "Respect .gitignore files when showing file and symbol completions"
}
```

**Accessor**: `ConfigurationUtils.shouldRespectGitignoreForCompletions()` in `src/utils/ConfigurationUtils.ts`

---

## Implementation

### File Discovery — `src/completions/CompletionHelpers.ts`

`getWorkspaceFiles()` always calls `vscode.workspace.findFiles("**/*", "**/.git/**")` to get all files (no manual excludes like `node_modules/` or `dist/`). The `.git/` directory is the only hardcoded exclusion since it's never useful in prompts.

> **Key insight**: VS Code's `findFiles()` does **not** respect `.gitignore` regardless of the exclude parameter ([VS Code issue #48674](https://github.com/microsoft/vscode/issues/48674)). Manual exclude patterns were previously used but only covered hardcoded directory names and bypassed gitignore entirely. The Git Extension API is the only reliable approach.

```typescript
const respectGitignore =
  ConfigurationUtils.shouldRespectGitignoreForCompletions();

const files = await vscode.workspace.findFiles("**/*", "**/.git/**");

const filteredFiles = respectGitignore
  ? await filterGitIgnoredFiles(files)
  : files;
```

### Git Extension Filtering — `filterGitIgnoredFiles()`

Uses the VS Code Git Extension's `repository.checkIgnore()` API:

1. Groups files by Git repository (handles multi-root workspaces)
2. Calls `repo.checkIgnore(filePaths)` for each repository in a single batch
3. Files not in any Git repository are kept as-is
4. Falls back to returning all files if the Git extension is unavailable

### Caching

File results are cached for 5 seconds (`CACHE_DURATION_MS = 5000`) to avoid repeated Git API calls during active typing.

---

## Behavior

| Setting          | Effect                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| `true` (default) | Gitignored files hidden — `node_modules/`, `dist/`, `out/`, build artifacts, logs, etc. |
| `false`          | All files shown — only `.git/` directory excluded                                       |

**When to use `false`**: Referencing dependency types in `node_modules/`, compiled output in `dist/`, `.log` files for debugging prompts, generated docs, gitignored `.env.example`, etc.

---

## Dashboard Webview Integration

The `respectGitignore` flag is also respected for completions in the CodeMirror prompt editor in the dashboard webview. The extension reads the setting and passes it along with completion responses:

- `src/ui/FlightPathWebviewProvider.ts` — `shouldRespectGitignoreForCompletions()` called when handling `requestCompletions` messages from the webview (both file and hash completion paths)
- The webview sends `requestCompletions` to the extension; the extension responds via the same `CompletionHelpers.ts` functions, so all completions — editor and dashboard — share the same filtering logic.

---

## Files

| File                                          | Purpose                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| `src/completions/CompletionHelpers.ts`        | `getWorkspaceFiles()` + `filterGitIgnoredFiles()`       |
| `src/utils/ConfigurationUtils.ts`             | `shouldRespectGitignoreForCompletions()` accessor       |
| `src/ui/FlightPathWebviewProvider.ts`         | Passes `respectGitignore` in webview completion handler |
| `src/ui/webview-react/store/settingsStore.ts` | `respectGitignore` state (default `true`)               |
