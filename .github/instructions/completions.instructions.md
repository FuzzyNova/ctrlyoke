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
`src/extension.ts` registers `PromptCompletionProvider` once, with every trigger (`@`, `#`, `~`, `---
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
, `!`, `/`), on prompt files (the globs from `getCtrlYokeFileGlobs()`, plus the `prompt` language). Keep it one registration: VS Code calls every registration on Ctrl+Space, so one per trigger listed every item several times. `PromptLinkProvider` uses the same selector set.

If you add a new trigger or reference form, update all of these together:

- `extension.ts` registration
- `PromptCompletionProvider` trigger routing/context checks
- `CompletionHelpers` / `ContextReferenceBuilder`
- `PromptLinkProvider`
- `src/ui/PromptEditorSupportService.ts` if the dashboard should support it too
  </registration>

<ctrlyokeFileDetection>
`CtrlYokeFileKind.ts` is the single "is this a ctrlyoke file" predicate (`getCtrlYokeFileKind`) and the source of the VS Code globs (`getCtrlYokeFileGlobs`). Add a new workflow or prompt suffix there only; workflow discovery (`WorkflowFileDiscovery`), the secret registry scan and the bundle analyzer all call it, so a bare `ctrlyoke.yaml` or `prompt.md` (no stem) is deliberately not a workflow file anywhere. The Node language-server host imports it too: `LanguageIntelligenceHost` refuses ctrlyoke files (reason `CTRLYOKE_FILE`) so a generic YAML, JSON or Markdown server never attaches next to ctrlyoke's own support.

`WorkflowDocumentLocation.ts` (`getWorkflowLocation`, `findRangeForPath`) answers "where is the cursor and which schema object owns it" for all three kinds. Prompt- and script-bearing fields are listed once in `WORKFLOW_TEXT_FIELDS` (`WorkflowLocationTypes.ts`); add a new text field there. Everything is pure (no `vscode`, no `fs`). Keep the YAML half in `WorkflowLocationYaml.ts` so the webview can `import()` it lazily; the facade imports it statically and is for the Node and VS Code hosts. Both VS Code completion providers gate on it; no provider keeps a private scanner.

Workspace-editor schema diagnostics use `PromptFileParser.validateWorkflowText()` on the host through `VALIDATE_WORKFLOW_DOCUMENT`; keep `ajv` out of the webview. Convert JSON Pointers with the pure `WorkflowPathFromInstancePath.ts` helper before `findRangeForPath()`. The editor's lint adapter validates only ctrlyoke files, uses a 400 ms delay and discards superseded sequence replies. Resolve ranges through `loadWorkflowFileSupport()` so a static import does not pull the YAML parser into the dashboard's first chunk.

**Run prompt-text rules on decoded spans, never on the raw file.** `WorkflowLocation.valueRange` is a raw source span (escapes, block indentation and unchomped line breaks included). Anything that applies a prompt rule across a document (`findCodeRanges`, reference scanning, prompt lint, chips) takes `getWorkflowTextSpans()` (`WorkflowPromptRanges.ts`) instead: each span's `text` is the value exactly as the loader decodes it (dedented, folded, chomped, unescaped; a `.prompt.md` body trimmed), and `toSourceOffset()` maps a result back to the document. A YAML block body in the raw file is indented, so a fence inside it looks indented past CommonMark's three spaces and `findCodeRanges` misses it. `PromptCodeRanges.ts` (`getPromptCodeRanges`) is that rule applied to literal code: `findCodeRanges` over each span, mapped back to document offsets. `PromptLinkProvider` drops links inside it and `PromptCompletionProvider` returns nothing with the cursor inside it, because a reference in code is sent as text and never expanded. Non-ctrlyoke files are scanned whole only for the `markdown`/`prompt` languages. The decoders live in `WorkflowTextDecoding.ts` and are checked against the `yaml` parser's own value. An explicit indentation indicator (`|2`) counts from the parent node's column (the key's column for `  - prompt: |2`), not the header line's indent. On a mismatch the span carries the parser's text with `exact: false`, and its `toSourceOffset` is only approximate. No known layout mismatches any more, but a consumer that maps results back must still check `exact`: code ranges fall back to the raw source slice, VS Code lint skips the span, because a range on the wrong characters (a suppressed live reference, a misplaced squiggle) is worse than none.

**Prompt lint in VS Code** is `PromptDiagnosticsProvider` over `getWorkflowPromptDiagnostics()` (`WorkflowPromptDiagnostics.ts`), which feeds each span to the shared `PromptDiagnosticRules`. References resolve through `PromptEditorSupportService.validateContextReferences`, so VS Code and the dashboard agree. It passes `hasPreCondition: true` on purpose: a step can inherit a pre-condition the file doesn't show, so `$preCondition:` is never flagged here. Don't "fix" that to `false`; it would flag valid prompts. For the same reason a `.prompt.md` body gets the most permissive position context (`PROMPT_MARKDOWN_SPAN_CONTEXT`): a workflow step's `prompt`, `finalStep` or `retryPrompt` can name the file, and `WorkflowExecutor.resolveEffectivePrompt` swaps the body in before expansion, so `$previous`, `$step:N` and `$endCondition:` are valid there. The provider validates with `{ resolveSymbolKind: false }` (squiggles never show a kind) and re-lints on `configService` and `externalRootsTrustStore` changes.
</ctrlyokeFileDetection>

<promptMarkdownGrammar>
`syntaxes/ctrlyoke-prompt-markdown.injection.json` is generated (never hand-edited) by `scripts/generate-prompt-markdown-injection.mjs` from the `promptText` keys of `WORKFLOW_TEXT_FIELDS`; a new prompt field reaches it on `npm run compile` and `check:docs` fails on drift. It injects markdown into `source.yaml` prompt values only (JSON prompts are escaped strings; quoted YAML scalars are left alone). The selector is `L:source.yaml -comment -string.quoted`: the key lookbehind matches text anywhere, so without the exclusions a comment such as `# use prompt: |` opens a block that turns the rest of the file, in any YAML file, into markdown.

**The injection must never consume the key line.** VS Code's YAML grammar is `while`-based: the `- ` and `key:` of a line push sequence/mapping frames, and a rule that swallows them leaves every later line scoped as a multi-line plain scalar. So the rules start from a fixed-width lookbehind on `prompt: ` and consume nothing before the value, and the block-scalar rule is a copy of the YAML 1.2 grammar's own (same `while`s) with markdown patterns added. The markdown grammar's heading rule allows only three columns of indent, so the injection carries its own. `promptMarkdownGrammar.integration.test.ts` reads real tokens and is what notices a VS Code YAML grammar change.
</promptMarkdownGrammar>

<workflowFileCompletions>
`WorkflowFileCompletionCore.ts` (`getWorkflowFileCompletions`) turns a `WorkflowLocation` plus the parsed document (`parseWorkflowDocumentRoot`) into key and value `PlainCompletionItem`s and the range they replace. It is pure; the host supplies dynamic lists through `WorkflowValueDataSource` and routes prompt text, script text, permission, branch and path completions itself (the core returns nothing for those roles). Keys come from the generated outline filtered by the document, never from a hand list: a step with no `prompt`/`script`/`type`/`parallel` yet is undecided and gets the union, and a root's single-step and multi-step keys are filtered by what the file already contains.

Multi-line key inserts are re-indented to the key's column in the core, because CodeMirror does not adjust snippets the way VS Code does. Hand-authored text goes in `WorkflowPropertySnippets.ts`; a key whose meaning differs per object belongs in `WORKFLOW_KIND_PROPERTY_SNIPPETS`, and `getWorkflowPropertySnippet(objectKind, key)` is the only lookup. Do not write `onPass`/`onFail` detail text by hand: the allowed actions differ per object, so the detail comes from that object's outline enum. Step numbers for `priorContext`/`sessionId` are counted after parallel groups are flattened, matching the loader. Inserts must leave a parseable document with no adapter-side fix-up, because CodeMirror does not repair them the way VS Code's JSON service does: inside a YAML flow collection (`location.inFlowCollection`) a key inserts the single-line `key: ` (a block snippet is a `BLOCK_IN_FLOW` error), and a JSON key or array element after a complete value gets a leading `, ` from `isAfterJsonValue()`. JSON string escaping for inserted text is `escapeJsonStringFragment` (`src/utils/JsonStringEscape.ts`) for every host.
</workflowFileCompletions>

<promptCompletionProvider>
`PromptCompletionProvider` completes prompt tokens in prompt text only, decided by `getWorkflowLocation` for a ctrlyoke file (role `PROMPT_TEXT`: a step's `prompt`, `finalStep`, `retryPrompt`, `passRetryPrompt` and a `.prompt.md` body, never frontmatter, script text or comments) and by language for any other markdown / `prompt` document, which is prompt text throughout. The gate runs after the trigger is found, so ordinary typing never parses the file.

For YAML, explicit replacement ranges are required; without them the YAML extension suppresses completions. Keep `CompletionList(..., true)` for trigger-based completions even though VS Code may visually duplicate entries; `false` breaks live refresh for symbol filtering.

`/` opens the ctrlyoke `/skill:` and `/mcp:` tokens (`getCtrlYokeSlashCompletions`, the same source as the dashboard). Unlike the other triggers its item text includes the trigger, so its range starts on the `/`, and it only fires at a line start or after whitespace (`findSlashTokenStart`), so `./` and `src/` never open the list.
</promptCompletionProvider>

<completionHelpers>
`CompletionHelpers.ts` owns the expensive discovery/caching logic:
- workspace file cache: 5s
- git refs cache: 10s
- cache invalidation comes from `initializeCompletionHelpers(context)` subscribing to `configService`

`ctrlyoke.respectGitignoreForCompletions=true` switches file discovery to `git ls-files --cached --others --exclude-standard`; do not try to emulate gitignore with `findFiles()`.

**Fuzzy matching is single-sourced in `FuzzyRanking.ts` (fuzzysort).** Rank _then_ truncate — the path sources cap at 450–500 items, and truncating an unranked list silently drops the best match on large repos. `vscode.executeWorkspaceSymbolProvider` does no matching of its own (Ctrl+T's fuzziness is a post-filter over the same provider results), and tsserver's `navto` matches an all-lowercase query only as one contiguous substring (`usecontext` never returns `useFinalStepContextMenu`; `useContext` does). So `getSymbolCompletions()` also queries a 3-character prefix and fuzzy-ranks the union itself — don't "simplify" that back to a single provider query.

**A response carrying `rank` is shown unfiltered by the webview.** `buildCodeMirrorCompletionResult` sets `filter: false` when any item has `rank`, because CodeMirror's own matcher re-sorts and also drops valid matches (one-character queries only match at the label start; gapped two-character queries never match). With filtering off CodeMirror computes no match ranges, so the same function supplies `getMatch` from `fuzzyMatchRanges()` to keep the bold match highlighting. `PromptEditorSupportService.emitCompletionsResponse()` forwards `PlainCompletionItem` fields to the webview by an explicit whitelist — a new item field (as `rank` once was) silently never reaches the dropdown until it's added there. Consequence: every _other_ item in a ranked response (output channels, the `#` selection item) must already be filtered against the query extension-side.

`getPromptFileCompletions()` is webview-only for lone prompt-file paths like `./foo.prompt.md`; VS Code `@/#/~/$` completion does not use it.

**Progressive `#` completion (webview/CodeMirror only):** `#` mixes instant editor selections with the potentially slow `vscode.executeWorkspaceSymbolProvider` query. `getHashSelectionCompletions()` returns just the selection items (synchronous) with the same `0_` sortText prefix `getHashCompletions()` applies, so the two share one source. `PromptEditorSupportService.handleCompletionRequest` emits selections first as a `COMPLETIONS_RESPONSE` with `partial: true`, then the full selections+symbols list with `partial: false` (same `seq`). `CodeMirrorEditor` resolves the CodeMirror completion promise on the partial (dropdown appears immediately), then — since the promise is already settled — caches the full result keyed by trigger+query and calls `startCompletion(view)` to re-trigger; `customCompletions` serves the cache synchronously with no second round trip. The `seq` guard discards a stale full response if the user kept typing. VS Code's `PromptCompletionProvider` cannot do this within a single `provideCompletionItems` call, so it still awaits the full `getHashCompletions()`.

**`CompletionItemKind.Unit` is reserved for the selection completion item.** `getSelectionCompletions()` deliberately assigns `kind: Unit` (not `Reference`) to the "current selection" item so the webview's kind→codicon map (`COMPLETION_KIND_ICONS` in `CodeMirrorEditor.tsx`) can give it a distinct `list-selection` icon — `~` git completions already occupy `Reference` (17), and without a separate kind the two were indistinguishable to any client picking an icon by `kind`. If you ever need `Unit` for something semantically real, pick a different currently-unused kind for the selection marker instead of colliding.

**`findSymbolKindForReference()` is webview-icon-only, not part of insertion.** It re-resolves an already-inserted generic or kinded `#sym:path:Name:start-end` reference's real `SymbolKind` for icon purposes, because hand-authored or pasted references may have no embedded kind and an embedded kind can become stale. `PromptEditorSupportService.validateContextReference` calls it during the existing context-ref validation pass and returns `symbolKind` alongside `exists`; `CodeMirrorEditor`'s atomic-chip pipeline caches that by `symbolIconCacheKey(path, symbolName, lineStart, lineEnd)` and dispatches a `symbolKindsUpdatedEffect` to upgrade or correct the chip icon once resolved. A miss leaves the chip on its embedded kind, or the generic `symbol-misc` fallback when no kind is present — this is best-effort display polish, not correctness-critical.
It tries `executeDocumentSymbolProvider` (exact name+range match, see `findDocumentSymbolByNameAndRange`) first, then falls back to `executeWorkspaceSymbolProvider` queried by name (see `findWorkspaceSymbolByUriNameAndRange`). **Both are required** — `getSymbolCompletions()` (the source of every `#sym:` completion item) builds references from `executeWorkspaceSymbolProvider`'s `SymbolInformation.location.range`, but that provider's navigateTo-style index frequently surfaces symbols (deeply nested object keys, CSS custom properties inside a JS style object, etc.) that the document outline (`executeDocumentSymbolProvider`) never includes at all — and even where both include a symbol, the two providers aren't guaranteed to agree on its range. Matching only against document symbols silently strands any reference built from one of those workspace-only symbols on the generic icon forever; the fix is to re-query the _same_ provider the reference was built from, not to loosen the document-symbol match.
`CodeMirrorEditor`'s completion `apply` also seeds `symbolIconCache` synchronously, from the picked completion item's own (already-known) `kind`, before the round trip ever runs — this is what prevents the visible flash to `symbol-misc` in the common case of picking a `#sym:` completion. It cannot help a pasted or hand-typed reference, which has no completion item to draw a kind from; those still rely on the round trip above.
</completionHelpers>

<workflowFileCompletionProvider>
`WorkflowFileCompletionProvider` is the VS Code host of `getWorkflowFileCompletions`: key and value completions for YAML, JSON and `.prompt.md` frontmatter, registered on every ctrlyoke glob with ` ` and `"` as triggers so a value list opens right after `key: ` or `"key": "`. It returns nothing for prompt text (that is `PromptCompletionProvider`'s), script text, comments and unknown objects. Its `WorkflowValueDataSource` reads the services the dashboard's pickers read: models come from `buildHarnessModelOptions()` (`utils/HarnessModelOptions.ts`, also what `WebviewSettingsSync` sends the webview, `None` dropped), the default harness from `ConfigurationUtils.getIntegrationMode()`. The data source is synchronous, so agents, skills, MCP servers and secret names are fetched before the call and only for the field under the cursor (discovery touches the file system). Insert text goes through `toVSCodeWorkflowCompletionItem` unescaped: the core already quotes JSON keys and values. Prompt-token items go through `toVSCodeCompletionItem` with the escape `getWorkflowInsertEscape(location)` picks (`WorkflowInsertEscape.ts`, shared with the workspace editor): JSON escaping in a JSON string or YAML double-quoted scalar, `'` doubled in a single-quoted one, none in plain/block scalars and markdown.

**VS Code filters a list on the text from the item's range start to the cursor, against `filterText` (else the label).** Whenever a range starts on a character the label lacks, set `filterText` to match, or VS Code silently hides every item while a direct provider call in a test still returns them: `/skill:` items (range starts on the `/`) filter on the full token, and JSON key/value items (range starts on the opening quote) on the quoted insert text. Multi-line workflow items are already indented to the key's column by the core, so `toVSCodeWorkflowCompletionItem` sets `keepWhitespace`; without it VS Code adds the line's indentation a second time.

Its key sets come from the generated `WORKFLOW_SCHEMA_OUTLINE` (`src/types/generated/WorkflowSchemaOutline.ts`), built from `schemas/workflow-schema.json` by `scripts/generate-workflow-schema-outline.mjs` (part of `npm run schema:update` and `precompile`; `check:docs` fails on drift). It records, per `WORKFLOW_OBJECT_KINDS` entry, the authorable keys with value kind, enum, default, description and `deprecated`, plus the keys the schema forbids there. Runtime-only fields are excluded in the generator's `RUNTIME_ONLY_KEYS`; a new object kind needs an entry in its `OBJECT_SOURCES`. A new schema property is offered automatically. Display details and insertion text are hand-authored in `WorkflowPropertySnippets.ts`, which is pure so both hosts can import it; a test fails if a snippet's key leaves the schema.

Tests use `PromptDocumentStub` with a real ctrlyoke file name: an untitled `openTextDocument` has no ctrlyoke file kind, so both providers decline it.
</workflowFileCompletionProvider>

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
