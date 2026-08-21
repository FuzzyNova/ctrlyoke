---
applyTo: "src/completions/**"
---

<purpose>
Prompt-file completion and navigation layer. This directory owns VS Code completions/links plus the shared reference-formatting helpers that the dashboard webview also reuses.
</purpose>

<architecture>
**Single shared engine:** `CompletionHelpers.ts` is not VS Code-only glue. `PromptCompletionProvider` uses it for editor IntelliSense, and `src/ui/PromptEditorSupportService.ts` uses the same helpers for CodeMirror completions in the dashboard. Keep trigger behavior, labels, and `insertText` framework-agnostic here.

**Single reference syntax source:** `ContextReferenceBuilder.ts` is the source of truth for emitted `@`, `#selection:`, `#sym:`, and `~` references. Do not hand-roll quoting, slashes, or trailing-slash behavior anywhere else.

**Two navigation entry points:** `PromptLinkProvider.ts` resolves references already typed into prompt files; `ContextMenuReferenceCommands.ts` creates those same references from Explorer/SCM/timeline actions and inserts them through the webview prompt editor.
</architecture>

<registration>
`src/extension.ts` registers the same `PromptCompletionProvider` four times for `@`, `#`, `~`, and `$` on prompt files (`*.{prompt,ctrlyoke}.json`, `*.ctrlyoke.{yaml,yml}`, `*.prompt.md`, and `prompt` language). `PromptLinkProvider` uses the same selector set.

If you add a new trigger or reference form, update all of these together:

- `extension.ts` registration
- `PromptCompletionProvider` trigger routing/context checks
- `CompletionHelpers` / `ContextReferenceBuilder`
- `PromptLinkProvider`
- `src/ui/PromptEditorSupportService.ts` if the dashboard should support it too
  </registration>

<promptCompletionProvider>
`PromptCompletionProvider` is intentionally context-gated:
- JSON/JSONC: only inside `"prompt"` strings, plus model completions inside `"model"` strings
- YAML/YML: only inside `prompt:` values, including block scalars
- Markdown / `prompt` language: anywhere

For YAML, explicit replacement ranges are required; without `calculateCompletionRange()` the YAML extension suppresses completions. Keep `CompletionList(..., true)` for trigger-based completions even though VS Code may visually duplicate entries; `false` breaks live refresh for symbol filtering.

Model completions are JSON/JSONC-only and replace the entire quoted model value, sourced from `COPILOT_CLI_MODEL_IDS`/`COPILOT_CLI_MODEL_LABELS` in `ModelConstants.ts` — ctrlyoke doesn't query VS Code's Language Model API.
</promptCompletionProvider>

<completionHelpers>
`CompletionHelpers.ts` owns the expensive discovery/caching logic:
- workspace file cache: 5s
- git refs cache: 10s
- cache invalidation comes from `initializeCompletionHelpers(context)` subscribing to `configService`

`ctrlyoke.respectGitignoreForCompletions=true` switches file discovery to `git ls-files --cached --others --exclude-standard`; do not try to emulate gitignore with `findFiles()`.

`getPromptFileCompletions()` is webview-only for lone prompt-file paths like `./foo.prompt.md`; VS Code `@/#/~/$` completion does not use it.

**Progressive `#` completion (webview/CodeMirror only):** `#` mixes instant editor selections with the potentially slow `vscode.executeWorkspaceSymbolProvider` query. `getHashSelectionCompletions()` returns just the selection items (synchronous) with the same `0_` sortText prefix `getHashCompletions()` applies, so the two share one source. `PromptEditorSupportService.handleCompletionRequest` emits selections first as a `COMPLETIONS_RESPONSE` with `partial: true`, then the full selections+symbols list with `partial: false` (same `seq`). `CodeMirrorEditor` resolves the CodeMirror completion promise on the partial (dropdown appears immediately), then — since the promise is already settled — caches the full result keyed by trigger+query and calls `startCompletion(view)` to re-trigger; `customCompletions` serves the cache synchronously with no second round trip. The `seq` guard discards a stale full response if the user kept typing. VS Code's `PromptCompletionProvider` cannot do this within a single `provideCompletionItems` call, so it still awaits the full `getHashCompletions()`.

**`CompletionItemKind.Unit` is reserved for the selection completion item.** `getSelectionCompletions()` deliberately assigns `kind: Unit` (not `Reference`) to the "current selection" item so the webview's kind→codicon map (`COMPLETION_KIND_ICONS` in `CodeMirrorEditor.tsx`) can give it a distinct `list-selection` icon — `~` git completions already occupy `Reference` (17), and without a separate kind the two were indistinguishable to any client picking an icon by `kind`. If you ever need `Unit` for something semantically real, pick a different currently-unused kind for the selection marker instead of colliding.

**`findSymbolKindForReference()` is webview-icon-only, not part of insertion.** It re-resolves an already-inserted generic or kinded `#sym:path:Name:start-end` reference's real `SymbolKind` for icon purposes, because hand-authored or pasted references may have no embedded kind and an embedded kind can become stale. `PromptEditorSupportService.validateContextReference` calls it during the existing context-ref validation pass and returns `symbolKind` alongside `exists`; `CodeMirrorEditor`'s atomic-chip pipeline caches that by `symbolIconCacheKey(path, symbolName, lineStart, lineEnd)` and dispatches a `symbolKindsUpdatedEffect` to upgrade or correct the chip icon once resolved. A miss leaves the chip on its embedded kind, or the generic `symbol-misc` fallback when no kind is present — this is best-effort display polish, not correctness-critical.
It tries `executeDocumentSymbolProvider` (exact name+range match, see `findDocumentSymbolByNameAndRange`) first, then falls back to `executeWorkspaceSymbolProvider` queried by name (see `findWorkspaceSymbolByUriNameAndRange`). **Both are required** — `getSymbolCompletions()` (the source of every `#sym:` completion item) builds references from `executeWorkspaceSymbolProvider`'s `SymbolInformation.location.range`, but that provider's navigateTo-style index frequently surfaces symbols (deeply nested object keys, CSS custom properties inside a JS style object, etc.) that the document outline (`executeDocumentSymbolProvider`) never includes at all — and even where both include a symbol, the two providers aren't guaranteed to agree on its range. Matching only against document symbols silently strands any reference built from one of those workspace-only symbols on the generic icon forever; the fix is to re-query the _same_ provider the reference was built from, not to loosen the document-symbol match.
`CodeMirrorEditor`'s completion `apply` also seeds `symbolIconCache` synchronously, from the picked completion item's own (already-known) `kind`, before the round trip ever runs — this is what prevents the visible flash to `symbol-misc` in the common case of picking a `#sym:` completion. It cannot help a pasted or hand-typed reference, which has no completion item to draw a kind from; those still rely on the round trip above.
</completionHelpers>

<yamlWorkflowKeys>
`PromptPropertyCompletionProvider` is narrowly scoped to YAML workflow editing:
- only activates in `.ctrlyoke.yaml` / `.ctrlyoke.yml`
- only offers keys inside `steps:` list items
- branches on whether the current item contains `type: script`
- also owns `type: prompt | script` enum-value completions

Its property lists are hand-maintained, not schema-derived. If workflow step fields change in `DashboardConstants` or the schema, this provider must be updated explicitly.
</yamlWorkflowKeys>

<referenceContracts>
All emitted references must stay workspace-relative and use forward slashes. Paths with spaces are quoted; directory refs always keep a trailing slash because that is how ctrlyoke distinguishes structure-only attachment from file attachment.

Quoted-path support must remain symmetric across:

- `ContextReferenceBuilder`
- `PromptLinkProvider` regexes
- `ContextMenuReferenceCommands`
- any parser/expander consuming the references

`PromptLinkProvider` recreates regexes per call because the patterns use `/g`; reusing the same regex instances will produce `lastIndex` bugs.

Any code that turns a parsed ref's `path` into an openable URI (link providers, click handlers, the dashboard's "open file" message handler) must resolve it with `resolveNamedRelativePath()` (`src/platform/WorkspaceRootResolver.ts`) + `getVsCodeNamedWorkspaceRoots()`/`getVsCodeTrustedWorkspaceRoots()`, not a plain `path.join(workspaceRoot, relativePath)`. A folder-name-prefixed ref (`root2/src/index.ts`, from a multi-root `.code-workspace`) joined onto only the primary root produces a nonexistent path — `PromptLinkProvider.ts` and `PromptEditorSupportService.handleOpenFile()` (the target of `MESSAGE_TYPES.OPEN_FILE`, which both `CodeMirrorEditor.tsx`'s click handler and `OutputRow.tsx`'s `PromptReferenceText` post through the shared `openContextReference()` helper) both had this bug independently before being fixed to match `ContextExpander`/`AttachmentBuilders`. Pair the resolve with `FileAccessPolicy.evaluateFileAccess()` (`src/utils/FileAccessPolicy.ts`) rather than a raw `isPathWithinAnyDirectory` check: a ref outside every trusted root is not silently dropped — `PromptLinkProvider` still emits a link, but pointed at the shared `ctrlyoke.confirmExternalFileTrust` command (via `buildTrustCommandUri`) so Ctrl+click offers the same "Trust Parent Folder" flow as dashboard output links, instead of the reference becoming un-clickable. See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
</referenceContracts>

<contextMenuCommands>
`ContextMenuReferenceCommands` never edits text directly. It always calls `webviewProvider.enqueuePromptEditorInsert()` with a `PromptEditorInsertRequest` and `PROMPT_EDITOR_INSERT_MODES.INSERT`. Keep that flow aligned with `WebviewMessageTypes.ts`.

Commands should fail gracefully for non-workspace URIs rather than emitting absolute paths. `addSymbolToPromptEditor()` intentionally falls back to a single-line `#selection:` ref if symbol lookup fails.
</contextMenuCommands>
