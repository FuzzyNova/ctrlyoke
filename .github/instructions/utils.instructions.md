---
applyTo: "src/utils/**"
---

<scope>
`src/utils/` is the shared helper layer used by core workflow execution, harness integrations, the VS Code shell, the standalone CLI, and a few webview-safe helpers. Keep utilities here focused on reusable behavior or single-source-of-truth constants/helpers, not feature-specific orchestration.
</scope>

<architecture>
This folder has a few important seams:

- **Config and runtime boundaries:** `ConfigurationUtils` is the compatibility facade over `CtrlYokeConfigService`; `CONFIG_KEYS`, `CONFIG_SCOPE`, and `PATH_CONSTANTS` are the canonical constants consumed across the app. Core code should read settings through these helpers, not through ad hoc VS Code config access.
- **Execution-property resolution pipeline:** `PropertyResolver` resolves prompt/workflow/settings precedence, `VarSubstitutor` applies `{{var}}` expansion after resolution, and `SessionResolver` decides whether a step reuses a session. These files define workflow inheritance semantics, so changes here ripple widely.
- **Prompt/context expansion pipeline:** `FileReferenceParser` parses `@`, `#selection`, `#sym`, `~`, and inline `$...` refs; `AttachmentBuilders` and `ContextExpander` turn the non-native ones into XML/context payloads; `PriorContextPreviewBuilder` must stay aligned with the live injection format by using the same builder path as runtime execution.
- **Discovery and file-management helpers:** `HarnessDirectoryUtils` is the single source of truth for where harness/user/workspace agent and skill files live. `AgentDiscovery`, `SkillDiscovery`, and `HarnessFileManager` should build on it rather than re-encoding paths or extensions.
- **MCP config stack:** `McpConfigPaths` knows where each harness stores MCP config, `McpDiscoveryUtils` reads external configs plus the public registry, `McpRegistryFileManager` manages ctrlyoke's own registry files, and `HarnessMcpExporter` projects the same server definition into each harness's native file format. Keep those responsibilities separate.
</architecture>

<criticalPatterns>
- Preserve **`null` vs `undefined` inheritance semantics** in resolver-style utilities. In this codebase, `null` usually means “explicitly disable inherited value” while `undefined` means “keep inheriting/fall back”.
- `SessionResolver` is intentionally strict about **same-harness-only** session reuse. Numeric `sessionId` references are 1-based prompt numbers, and the `"finalStep"` sentinel is a distinct resume path; do not loosen these rules casually.
- Keep shared runtime helpers truly shared. Files like `promptPathUtils`, `RangeNotationParser`, `ErrorUtils`, and `TypedEmitter` are safe to use outside the VS Code extension host; avoid introducing `vscode` or heavyweight Node-only dependencies into utilities that are consumed by the CLI or webview-safe code paths.
- `WorkflowLockManager` and `FileLockUtils` solve different problems: workflow runner ownership uses `.runner.json` heartbeat files, while `FileLockUtils` is a generic `.lock` wrapper for cross-process file mutation. `FileLockUtils` intentionally uses `console.warn` instead of `Log` because it is used by the MCP server too.
- `WorkspaceSnapshotService` is deliberately conservative: prefer git-backed snapshots when possible, exclude artifact directories (including `.ctrlyoke`), and avoid loading large/binary files fully into memory. Keep undo/redo semantics stable when changing snapshot behavior.
- `PromptFileSplitter` and `TempFileManager` are coupled to harness limitations. Splitting prefers whole `<attachment>` blocks, and temp files in `.ctrlyoke/temp/` use category-specific names because downstream debugging and cleanup rely on those conventions.
- ctrlyoke-owned agent/skill directories under `.ctrlyoke/` are intentionally **exclusive** to ctrlyoke so harness-native scrapers do not duplicate the same instructions/context. Discovery helpers dedupe overlapping directories on purpose; preserve that behavior.
</criticalPatterns>

<relatedFiles>
- `src/config/CtrlYokeConfigService.ts` — backing config service that `ConfigurationUtils` wraps
- `src/core/HarnessIntegration.ts` — shared prior-context XML builder used by `PriorContextPreviewBuilder`
- `src/ui/WebviewSettingsSync.ts` and `src/ui/WebviewMessageRouter.ts` — heavy consumers of MCP/config/discovery utils
- `src/completions/CompletionHelpers.ts` and `src/completions/ContextReferenceBuilder.ts` — editor-side consumers of parsing/discovery/model helpers
</relatedFiles>
