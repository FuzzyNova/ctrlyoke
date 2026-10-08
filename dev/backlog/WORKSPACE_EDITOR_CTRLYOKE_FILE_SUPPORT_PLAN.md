# Workspace Editor ctrlyoke File Support Plan

**Status (2026-10-07):** Proposed. Nothing is implemented yet.

**Priority:** P1. The built-in editor is the "real IDE on your phone" pitch
([`SCREENSHOTS_AND_MEDIA_PLAN.md`](SCREENSHOTS_AND_MEDIA_PLAN.md) #10), and a workflow file is
the file a ctrlyoke user is most likely to open in it. Today that file gets less help than it
gets anywhere else in the product.

**Related plans:**

- [`PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md`](PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md):
  markdown highlighting for prompt text. Its Phase 3 nests markdown inside this plan's YAML
  `PROMPT_TEXT` ranges. Schedule it with Phase 6 here.
- [`WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`](WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md):
  generic LSP features for `WorkspaceFileEditor.tsx`. This plan is its ctrlyoke-specific sibling.
  It shares the editor's extension-slot design, but it does not depend on any LSP phase and can
  ship first. See "Coexistence with the LSP plan" below.
- [`PROMPT_AUTHORING_SUGGESTIONS_PLAN.md`](PROMPT_AUTHORING_SUGGESTIONS_PLAN.md): model-written
  prompt continuations in the prompt editor. It is out of scope here, but once Phase 0 extracts
  the shared prompt-editing extensions, they become the natural place to add it.
- [`SCHEMASTORE_CATALOG_PLAN.md`](SCHEMASTORE_CATALOG_PLAN.md): schema validation in editors
  other than ctrlyoke. It does not overlap with this plan.

## Problem

The hosted dashboard's workspace viewer (`WorkspaceFileEditor.tsx`) is the only editor a
phone or browser user has. When they open `.ctrlyoke/workflows/foo.ctrlyoke.yaml` in it, they
get YAML syntax highlighting, CodeMirror's generic word completion from `basicSetup`, and
clickable `@file` links. They get none of the following:

- **Property completions:** valid keys at the cursor, such as `harness`, `endCondition` or
  `parallel`, with descriptions.
- **Value completions:** the six harness IDs, the models for the step's harness, agents,
  skills, MCP servers, secrets, `executionMode`, `priorContext` keywords and step numbers, the
  `type` discriminator, and script commands in `endCondition.script`.
- **Prompt-token completions inside prompt text:** the `@ # ~ $ ! /` completions the prompt
  editor already offers, inside `prompt:`, `retryPrompt:` and `passRetryPrompt:` values and in
  the body of a `.prompt.md` file.
- **Diagnostics:** schema errors and unresolved references while editing, instead of a load
  failure after save.

Editing a workflow in VS Code is better, but not complete. VS Code gets prompt-token
completions and key-only property completions in YAML (details below), plus schema validation
when the user happens to have Red Hat YAML installed. Building the support only into the
browser editor would leave the two hosts diverging. This plan builds one host-neutral core and
puts a CodeMirror adapter on it, then lets the VS Code providers use the same core.

## Key facts that shape the design

These were verified against `src/` on 2026-10-07.

1. **The workspace viewer exists only in the hosted browser.** `WorkspaceViewerModal` mounts
   only when `isStandalone` is set (`App.tsx`, `Header.tsx`). That flag comes from
   `window.__ctrlyokeStandalone`, which `standalone-shim.js` sets. File reads and writes use REST
   (`utils/hostedApi.ts` → `/api/workspace-viewer/file`). Every other dashboard request,
   prompt-editor completions included, uses `getVsCodeApi().postMessage`. In the browser that is
   a WebSocket shim into the same `WebviewMessageRouter` that VS Code uses
   (`DashboardApplication.ts`, `CtrlYokeHostedServer.ts`). So new completion requests from the
   workspace editor need **no new transport**.

2. **The workspace editor already has an autocompletion instance.** `WorkspaceFileEditor.tsx`
   loads `basicSetup`, which includes `autocompletion()`, `closeBrackets()` and
   `completionKeymap`. Adding a second `autocompletion({ override })` next to it would give two
   competing instances. Its tooltips also mount inside the editor rather than on `document.body`,
   and they don't use `keyboardTooltipSpace`. The prompt editor (`CodeMirrorEditor.tsx`
   `tooltips({ parent: document.body, tooltipSpace: keyboardTooltipSpace })`) shows how to do
   this correctly, including the `repositionTooltips` call on `visualViewport` changes.
   `@codemirror/lang-yaml` and `@codemirror/lang-json` provide no completion sources.

3. **The prompt editor's completion logic is half-extracted already.** These helpers are
   exported and pure:
   - `findCustomCompletionContext`, `findSlashCompletionContext`
   - `buildCodeMirrorCompletionResult`, `withReferenceBoundarySpace`
   - `createAtomicReferenceExtension`, `createContextReferenceLintExtension`,
     `createSlashTokenDecorationExtension`

   What is still trapped in the React component is the two completion sources
   (`customCompletions` and `pathCompletions`) and the transport state around them:
   - per-source sequence numbers, a pending-promise map and a progressive `#` cache
   - partial-then-full `COMPLETIONS_RESPONSE` handling (`handleCompletionResponse`)
   - the window `message` listener

   `hooks/useCompletionRequest.ts` is a generic seq/stale-response hook, but it has no
   partial/full support and the prompt editor doesn't use it.

4. **The host side of prompt-token completion is already shared and platform-neutral.**
   `WebviewMessageRouter` → `PromptEditorSupportService.getCompletionItems` routes each trigger
   to `CompletionCore`:
   - `/` → skills and MCP
   - `@` → files
   - `#` → symbols
   - `~` → git
   - `$` → prior context
   - `!` → secrets
   - `path` → prompt files

   `CompletionCore` doesn't import `vscode`. `NodeHostServices.ts` builds it for `ctrlyoke
server`, and `CompletionHelpers.getCompletionCore()` builds it for VS Code. The request
   carries only `trigger`, `prefix`, `position` and `seq`, with no file or step context.
   `SCRIPT_COMPLETIONS_REQUEST` and `PERMISSION_COMPLETIONS_REQUEST` already serve the
   properties panel's script and permission fields through the same service.

5. **VS Code's workflow-file support is regex scanning plus a disk-read schema.**
   - `PromptCompletionProvider` decides whether the cursor is in prompt text as follows:
     - Markdown: always.
     - YAML: inside a `prompt:` block scalar (`YamlBlockScalarContext.ts` plus a manual
       header/indent scan).
     - JSON: inside a single-line `"prompt": "…"`.

     It registers the triggers `@ ! # ~ $`, **with no `/`**. Its only value completion is JSON
     `"model"`, and that is hardcoded to Copilot model IDs whatever the harness.

   - `PromptPropertyCompletionProvider` (YAML only) offers **key** completions, plus `type:` →
     `prompt`/`script`.
     - Its keys come from `workflow-schema.json` `$defs.promptStep`/`scriptStep`, read with `fs`
       and `__dirname`.
     - Snippets and details come from a hardcoded `PROPERTY_OVERRIDES` table.
     - It finds the enclosing `steps:` or `parallel:` item by scanning indentation.
     - It offers no value completions.

   Neither provider covers `retryPrompt` or `passRetryPrompt`, root-level keys, nested objects
   (`endCondition`, `toolPermissions`, `hooks`, `worktree`) or `finalStep` as a distinct
   location.

6. **The schema and dynamic option lists already reach the webview.**
   - `src/types/generated/SchemaDescriptions.ts` (`SCHEMA_DESCRIPTIONS`, `SCHEMA_ENUMS`) is
     bundled in the webview. Settings and workflow paths share one flattened namespace, though,
     and it doesn't record which keys are valid in which object. It can supply descriptions and
     enums, but not structure.
   - `settingsStore` holds `modelOptions` per harness (`MODEL_OPTIONS_UPDATE`),
     `availableAgents`, `availableSkills` and per-harness model lists.
   - `useMcpManagerStore` and `secretRegistryStore` hold MCP servers and secret names.
   - `HARNESS_IDS` is a constant. So most value completions need no round trip at all.

7. **Pure modules under `src/completions/` and `src/utils/` are importable from the webview.**
   The prompt editor already imports `@root/completions/FuzzyRanking`,
   `@root/utils/ReferenceBoundary` and `@root/utils/ReferencePatterns`. `CompletionCore` is not
   one of them, because it pulls in Node `path` and git child processes. `jsonc-parser` and
   `js-yaml` are root dependencies, but the webview imports neither. The `yaml` package (2.9.1)
   is present only as a transitive devDependency of `knip` and `vite`.

8. **Workspace-viewer content is secret-redacted on read.**
   `HostedWorkspaceViewerService.readFile` redacts the content it returns, and `saveFile`
   rejects a redaction marker. Anything this plan sends back to the host for validation is
   editor text that was already redacted. It must not need the real values, and it must never
   echo them back.

## Options considered

| Option                                                                                                                                                                                                                      | Verdict                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Reuse the prompt editor's sources in the workspace editor, gated by the VS Code regex scanners.**                                                                                                                      | Rejected. It is quick, but it inherits the scanners' blind spots (fact 5), adds no property or value completions, and leaves VS Code and the browser with separate logic.                                                                                                                    |
| **B. Ride the LSP plan: `yaml-language-server` / `vscode-json-languageservice` with `workflow-schema.json` associated.**                                                                                                    | Rejected as the primary path, though it remains possible later (see Coexistence). It needs LSP Phases 1–4 and a server install the user opts into. Schema-only completion can't offer models for the step's harness, agents, skills, secrets, step numbers or any prompt token.              |
| **C. A browser JSON-schema CodeMirror library (e.g. `codemirror-json-schema`).**                                                                                                                                            | Rejected. It would be a third source of schema behaviour, separate from `PromptFileParser` and VS Code. Its ajv-based validation compiles with `new Function`, which needs `unsafe-eval` under the webview CSP. It has no dynamic values, and region detection would still have to be built. |
| **D. A host-neutral core under `src/completions/` covering cursor location, the schema outline and completion items, with a CodeMirror adapter for the workspace editor and the existing VS Code providers moved onto it.** | **Chosen.** There is one implementation of "where is the cursor in this workflow" and "what is valid here". The browser and VS Code converge, and the prompt-token path reuses the router and `CompletionCore` unchanged.                                                                    |

## Decision

```
WorkspaceFileEditor (hosted browser)                       VS Code
 ├─ Compartment: ctrlyokeFileSupport                        ├─ PromptPropertyCompletionProvider ─┐
 │   ├─ workflowPropertySource ──┐                          └─ PromptCompletionProvider ──────────┤
 │   ├─ workflowValueSource ─────┤ (pure, in-bundle)                                              │
 │   └─ promptTokenSource ───────┼──────────────┐                                                 │
 ▼                               ▼              │                                                 ▼
 src/completions/ (pure, no vscode, no fs):     │ REQUEST_COMPLETIONS / SCRIPT_… / PERMISSION_…
   WorkflowDocumentLocation   ◄─────────────────┼──────── same modules ──────────────────────────┘
   WorkflowFileCompletionCore                   ▼
   generated WorkflowSchemaOutline     WebviewMessageRouter → PromptEditorSupportService → CompletionCore
```

### Detecting a ctrlyoke file

Single-source the file predicate. `extension.ts` registers its providers on the globs
`**/*.{prompt,ctrlyoke}.json`, `**/*.ctrlyoke.{yaml,yml}` and `**/*.prompt.md`.
`PromptLinkProvider` has its own detection. Put one `getCtrlYokeFileKind(path)` in a pure
module that returns `WORKFLOW_YAML`, `WORKFLOW_JSON`, `PROMPT_MARKDOWN` or `null`, with the
kinds as constants in `DashboardConstants.ts`. Have `extension.ts`, `PromptLinkProvider` and
`WorkspaceFileEditor` all use it. The editor only attaches ctrlyoke support when it returns a
kind. Every other file is untouched.

### Cursor location: `WorkflowDocumentLocation`

A pure function, `getWorkflowLocation(text, offset, kind)`, returns:

- **`path`:** `(string | number)[]`, e.g. `["steps", 2, "endCondition", "retryPrompt"]`,
  `["steps", 0, "parallel", 1, "harness"]` or `["finalStep", "prompt"]`.
- **`role`:** one of `KEY`, `VALUE`, `PROMPT_TEXT`, `SCRIPT_TEXT` or `NONE`, defined as
  constants.
- **`objectKind`:** which schema object owns the key. It can be `WORKFLOW_ROOT`,
  `PROMPT_STEP`, `SCRIPT_STEP`, `PARALLEL_GROUP`, `END_CONDITION`, `PRE_CONDITION`,
  `TOOL_PERMISSIONS`, `WORKTREE`, `VARS` and so on. `type: script` and the presence of
  `script:` decide between a prompt step and a script step, as the VS Code provider does
  today.
- **`siblingKeys`:** keys already present, so they can be excluded from key completions.
- **`valueRange` and, for JSON, `jsonString: true`:** so inserted text can be escaped.
- **`findRangeForPath(text, path, kind)`:** the inverse, used for diagnostics.

The implementation per format:

- **JSON:** `jsonc-parser`'s `getLocation`, `parseTree` and `findNodeAtLocation`. These are
  error-tolerant and already a dependency.
- **YAML:** the `yaml` package (`parseDocument` with `keepSourceTokens`, `LineCounter`), added
  as a direct dependency.
  - It is error-tolerant on half-typed documents, gives node ranges in both directions, and is
    the parser `yaml-language-server` uses.
  - If a mid-edit document parses too badly to give a path (a dangling `- pro`), fall back to
    the indentation scan that `PromptPropertyCompletionProvider` and `YamlBlockScalarContext`
    already implement. Move that scan into this module rather than keeping a second copy.
- **`.prompt.md`:** everything after the optional frontmatter is `PROMPT_TEXT`. Inside the
  frontmatter, only `schemaVersion` is meaningful.

Text roles come from one constant table, `WORKFLOW_TEXT_FIELDS`, so a new prompt-bearing field
is added in one place:

- `PROMPT_TEXT`: `prompt`, `endCondition.retryPrompt` and `endCondition.passRetryPrompt`.
- `SCRIPT_TEXT`: `script` on script steps, `endCondition` and `preCondition`, and the hook
  `command`.

A `prompt` value that is a single-line path ending in `.prompt.md`, `.md` or `.txt` also gets
`path` completions, matching the schema's "OR a file path" rule.

### Schema knowledge: generated `WorkflowSchemaOutline`

`SchemaDescriptions.ts` is flat, so it can't say which keys a `parallel` group accepts.
Generate a structural companion, `src/types/generated/WorkflowSchemaOutline.ts`, from
`workflow-schema.json` in the same `npm run schema:update` pass. For each `objectKind` it
records:

- the allowed keys, resolved through `$ref`, `allOf` and `oneOf`, and excluding `_runtime`
  and other runtime-only fields
- for each key: its value kind (string, number, boolean, object, array, oneOf), its
  enum/const values, its default, its description and its `deprecated` flag
- which keys are forbidden in that context, e.g. `worktree`, `trustedExternalRoots` and
  `maxSteps` on steps, per the schema's `not` clauses

Snippet bodies and short details are editorial, not schema data. Move `PROPERTY_OVERRIDES` out
of `PromptPropertyCompletionProvider` into a pure, hand-authored `WorkflowPropertySnippets.ts`
that both hosts import. Add the outline to the drift check that already guards the generated
reference docs, so a schema change without a regenerate fails CI.

### Completion items: `WorkflowFileCompletionCore`

A pure function `getWorkflowFileCompletions(location, outline, data)` returns
`PlainCompletionItem[]`, the shape `CompletionCore` and `buildCodeMirrorCompletionResult`
already use.

- **Key items:** valid keys for `objectKind` minus `siblingKeys`, with the snippet when one
  exists. Insert `key: `, or for an object or array, `key:` plus a newline and indent.
- **Value items:** enum/const values from the outline, plus dynamic values from a
  `WorkflowValueDataSource` interface:

  | Field                                      | Source                                                                                                                           |
  | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
  | `harness`                                  | `HARNESS_IDS`                                                                                                                    |
  | `model`                                    | the **effective** harness's model list (step → enclosing workflow → `defaults.harness`), never a fixed Copilot list              |
  | `agent`, `skills[]`                        | available agents/skills                                                                                                          |
  | `mcpServers[]`                             | registered MCP servers, including the built-in `ctrlyoke`                                                                        |
  | `secrets[]`                                | secret registry names                                                                                                            |
  | `priorContext`, `sessionId`                | keywords plus step numbers counted from the document itself, with each step's `name` as the detail (`finalStep` for `sessionId`) |
  | `executionMode`, `type`, `errorBehavior.*` | outline enums                                                                                                                    |

  The webview implements the data source from `settingsStore`, `useMcpManagerStore` and
  `secretRegistryStore`. VS Code implements it from the services those stores mirror.

- **Host-backed values** stay host-side and reuse existing requests rather than new ones:
  - `SCRIPT_TEXT` → `SCRIPT_COMPLETIONS_REQUEST`
  - `toolPermissions.allow[]`/`deny[]` → `PERMISSION_COMPLETIONS_REQUEST`
  - `worktree` branch names → the branch completion helper
  - a prompt path → `REQUEST_COMPLETIONS` with `trigger: path`

### Prompt-token completions inside prompt values

When `role === PROMPT_TEXT`, the workspace editor runs the same `@ # ~ $ ! /` source as the
prompt editor, using the Phase 0 extraction. `REQUEST_COMPLETIONS`, `PromptEditorSupportService`
and `CompletionCore` stay exactly as they are. Additions:

- **JSON escaping.** Inside a JSON string, each inserted reference is escaped as a JSON string
  fragment before CodeMirror applies it. That covers `"`, `\` and newline, e.g. in
  `#selection:"docs/my notes.md":1-20`. `CompletionHelpers.toVSCodeCompletionItem` already
  JSON-escapes for VS Code. Lift that escape into the shared core so the two hosts can't drift.
  Trigger detection runs on the decoded string, so an escaped `\"` before `@` is not a
  word-start boundary.
- **Document-aware `$`.** The webview offers `$step:N` items, with step names as details,
  computed from the open document. Today's prior-context completions are static keywords only,
  because the prompt editor's request carries no step context. `$endCondition:` and
  `$preCondition:` fields are offered only where they resolve: in `retryPrompt` and
  `passRetryPrompt`, and in the prompt of a step that has the matching condition.
- **`{{var}}` completions** come from the document's own `vars` and `_templateMeta` blocks.
  This is new in both editors, and it lives in the shared core so the prompt editor can adopt
  it too.

### Editor integration

`WorkspaceFileEditor.tsx` changes as follows:

- **Replace `basicSetup` with an explicit setup.** Keep everything it provides except its
  `autocompletion()`. The editor then owns one `autocompletion` with
  `override: [workflowPropertySource, workflowValueSource, promptTokenSource]` for ctrlyoke files,
  and keeps CodeMirror's default word completion for every other file, so other files don't
  change.
- **Tooltips:** `tooltips({ parent: document.body, tooltipSpace: keyboardTooltipSpace })`, plus
  `repositionTooltips` in the existing `visualViewport` listeners. Phone editing is a headline
  use, and #10's capture clip is on a phone.
- **A `Compartment` named `ctrlyokeFileSupport`.** It is reconfigured when the file kind or the
  data-source snapshot changes. This is the same reason the LSP plan requires its slot to be a
  `Compartment`: rebuilding the `useMemo` extension list tears down the view and its undo
  history. The two compartments are siblings.
- **Keep the existing `.cm-link` decorator and click handler.** References outside chip
  ranges, and every reference when chips are off, keep rendering as links.
- **Lazy-load the YAML support.** The location module's YAML half, and the `yaml` package with
  it, is loaded with a dynamic `import()` the first time a `.ctrlyoke.yaml`/`.yml` file opens
  in the workspace editor. Vite puts it in its own chunk, so the dashboard's first paint never
  pays for it. Until the chunk resolves, the indentation-scan fallback answers location
  queries, so the first keystroke still gets completions. The VS Code host imports it
  statically.

### Atomic reference chips in YAML

Reference chips render in YAML workflow files and `.prompt.md` bodies. They never render in
JSON workflow files.

- **One setting.** Chips are controlled by the existing `ui.atomicContextReferences` setting,
  through the same `settingsStore.globalSettings.atomicContextReferences` selector the prompt
  editor reads. There is no workspace-editor-specific setting. Toggling it reconfigures the
  `ctrlyokeFileSupport` compartment live, without recreating the view.
- **Where they render.** Chips render only inside `PROMPT_TEXT` ranges from
  `getWorkflowLocation`: block scalars (`|`, `>`), plain scalars and quoted scalars. A
  reference written inside a quoted YAML scalar gets a chip only when its source text has no
  escape sequence, so the text under the chip is exactly what the parser decodes. Otherwise it
  stays a link. `@` text elsewhere in the file (comments, `name:`, `description:`) never
  becomes a chip.
- **Same widget as the prompt editor.** Reuse `createAtomicReferenceExtension` and
  `AtomicReferenceWidget`, which are already exported. Add an optional range limiter so the
  extension decorates only the ranges it is given rather than the whole document. The prompt
  editor passes no limiter and behaves as it does today.
- **Display only.** Chips replace how the text looks, not the text itself. Save writes the
  same bytes, copying a chip copies the reference text, and undo history is unaffected.
  Clicking or tapping a chip goes through the same `openToFile`/`openToDirectory` path as the
  existing links.
- **Why not JSON.** A reference inside a JSON string is escaped source text (`\"`, `\\`), so
  the characters under a chip would differ from the reference it stands for. Mixed-escape
  atomic ranges are not worth it for a format people rarely hand-edit in the browser. JSON
  keeps the link decoration. Decided 2026-10-07.
- **Hover** shows the outline description for a key. It is computed client-side, with no round
  trip.

### Diagnostics

- **Schema validation stays host-side, in `PromptFileParser`.** Do not bundle ajv into the
  webview. It needs `unsafe-eval`, and a second validator would drift from the one that
  actually loads files. Add a message pair: `VALIDATE_WORKFLOW_DOCUMENT { text, kind, seq }`
  answered by `WORKFLOW_DOCUMENT_DIAGNOSTICS { seq, issues: { path, message, severity }[] }`.
  - The host runs the parser's parse-and-validate step on the unsaved text with **no** load,
    run-storage or watcher side effects.
  - If `PromptFileParser` does not expose a side-effect-free validate entry point, add one.
    The load path should then call it rather than copy it.
  - The client maps each `instancePath` to a range with `findRangeForPath` and renders it with
    `@codemirror/lint`, debounced as the prompt editor's reference lint is.
- **Unresolved references** inside `PROMPT_TEXT` reuse `createContextReferenceLintExtension`
  and `VALIDATE_CONTEXT_REFS` unchanged.
- The text only travels to the host, which already holds the file (fact 8). Diagnostics carry
  paths and messages, never values.

### Coexistence with the LSP plan

ctrlyoke owns ctrlyoke files. When the LSP plan resolves `languageServers.use` for a file,
files that `getCtrlYokeFileKind` recognizes get no LSP session by default. Without that rule,
an installed `yaml-language-server` would offer generic schema completions next to these, with
two dropdowns and two sets of diagnostics. Add this rule to the LSP plan's Phase 3 when that
phase starts. A later opt-in could let `yaml-language-server` contribute formatting only.

## Implementation phases

Every phase lands with tests and leaves both editors working.

1. **Phase 0: Extract the prompt-editor completion client.** The behaviour must not change.
   - Move `customCompletions` and `pathCompletions` and their seq, pending, cache and
     partial/full state out of `CodeMirrorEditor.tsx` into
     `utils/promptCompletion/createPromptCompletionClient(transport)`. Move the tooltip and
     autocompletion config into `promptTokenCompletionExtension({ gate })`.
   - The window `message` listener becomes one module-level dispatcher keyed by `seq`, so two
     editors on screen don't steal each other's responses.
   - Tests: the existing `CodeMirrorEditor.test.tsx` completion describes must pass unchanged,
     plus client unit tests for partial-then-full and for cancellation.

2. **Phase 1: `WorkflowDocumentLocation` and the file predicate.**
   - Add `yaml` as a direct dependency. Keep the YAML half of the location module in its own
     file so the webview can `import()` it lazily, and confirm with a bundle check that it
     lands in a separate chunk.
   - Add `getCtrlYokeFileKind` and its constants, and move `extension.ts` and
     `PromptLinkProvider` onto it.
   - Add `getWorkflowLocation` and `findRangeForPath` for YAML, JSON and Markdown, and move the
     indentation-scan fallback in.
   - Tests: fixture-driven Mocha tests in `src/test/unit/`, alongside
     `YamlBlockScalarContext.test.ts`. Cover complete, half-typed and invalid documents, every
     `objectKind`, parallel members, `finalStep`, flow vs block YAML, and JSON escapes.

3. **Phase 2: `WorkflowSchemaOutline` and shared snippets.**
   - Generator step in `schema:update`, plus a drift check.
   - Move `PROPERTY_OVERRIDES` into `WorkflowPropertySnippets.ts`.
   - Move `PromptPropertyCompletionProvider` onto the outline. This removes its `fs` and
     `__dirname` schema read. Its existing tests must pass.

4. **Phase 3: `WorkflowFileCompletionCore`.**
   - Key and value items, and the `WorkflowValueDataSource` interface.
   - Effective-harness model resolution, document-derived step numbers, and the JSON escape
     lifted from `CompletionHelpers`.
   - Tests: pure Mocha tests with a stub data source.

5. **Phase 4: Workspace editor completions.**
   - Explicit setup in place of `basicSetup`, the `ctrlyokeFileSupport` compartment, and the
     three sources with body-mounted tooltips.
   - A webview `WorkflowValueDataSource` built from the stores.
   - `PROMPT_TEXT` gating for prompt tokens, plus `SCRIPT_TEXT` and permission routing.
   - Tests: `WorkspaceFileEditor.test.tsx` covers key, value and prompt-token completions in
     YAML, JSON and `.prompt.md`, and confirms non-ctrlyoke files are unchanged. Reuse
     `fixtures/completionRequests.ts`. Add a case to
     `nodeHostedServer.integration.test.ts` for a prompt-token request from a workflow-file
     context.

6. **Phase 5: Diagnostics and hover.**
   - `VALIDATE_WORKFLOW_DOCUMENT` / `WORKFLOW_DOCUMENT_DIAGNOSTICS`, including the type
     definitions in `WebviewMessageTypes.ts` and the router entry.
   - A side-effect-free validate in `PromptFileParser`.
   - Lint rendering and outline hover.

7. **Phase 6: Prompt-text polish.**
   - Atomic chips in YAML `PROMPT_TEXT` ranges and `.prompt.md` bodies, gated by
     `ui.atomicContextReferences` and never in JSON. This includes the range limiter for
     `createAtomicReferenceExtension`.
   - Tests (`WorkspaceFileEditor.test.tsx`):
     - chips render inside a YAML `prompt:` block scalar but not in a comment or `name:`
     - an escaped reference in a quoted scalar stays a link
     - no chips in `.ctrlyoke.json`
     - toggling the setting adds and removes chips without recreating the view
     - the saved text is byte-identical
   - `$step:` items with step names, and `$endCondition:`/`$preCondition:` scoping.
   - `{{var}}` completions, adopted by the prompt editor too.

8. **Phase 7: VS Code parity.** This can be done on its own schedule.
   - `PromptPropertyCompletionProvider` gains value completions and covers JSON through
     `WorkflowFileCompletionCore`, with a VS Code `WorkflowValueDataSource`.
   - `PromptCompletionProvider` gates on `getWorkflowLocation`. That adds `retryPrompt` and
     `passRetryPrompt` coverage and drops its private scanners.
   - It also registers the missing `/` trigger and replaces the hardcoded Copilot JSON `model`
     list.
   - Delete whatever the shared core has made dead, using `scripts/find-dead-methods.mjs`.

Phases 0–2 can land in any order. Phase 4 needs 0, 1 and 3. Nothing here needs the LSP plan's
standalone-server stages.

## Open questions

Resolved on 2026-10-07:

- **Bundle cost of `yaml` in the webview** (roughly 35 KB gzipped). It is loaded on first use,
  when a YAML ctrlyoke file first opens in the workspace editor. See "Editor integration".
- **Reference chips.** They render in YAML prompt text and `.prompt.md` bodies, gated by the
  single `ui.atomicContextReferences` setting. They never render in JSON workflow files. See
  "Atomic reference chips in YAML".

Still open:

1. **Settings files.** `.ctrlyoke/settings.json` has its own schema
   (`settings-schema.json`). The same outline-plus-location design would cover it with a second
   generated outline. That is out of scope here. Note it as follow-up work once Phase 3 proves
   the design.
