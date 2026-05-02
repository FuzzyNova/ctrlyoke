# VS Code "Add to FlightPath" Context Menus — Implementation Plan

**Date:** 2026-04-28  
**Purpose:** Add right-click and SCM-driven VS Code actions that insert FlightPath context references directly into the dashboard prompt editor, reusing the same reference syntaxes already supported by `ContextExpander` and `CompletionHelpers`.

---

## 1. Goal

Add a new `Add to FlightPath` workflow for the main VS Code surfaces where context already exists:

- File Explorer files
- File Explorer folders
- Editor selections
- Editor symbol/cursor context
- SCM changed resources
- Git commit items where VS Code exposes them

The output of every action should be a valid FlightPath reference string inserted into the prompt editor in `CodeMirrorEditor.tsx`, not a second attachment format.

---

## 2. Current State

### Existing reference support

`src/utils/ContextExpander.ts` and the parser/builders it uses already support the reference families we want to generate:

- `@path/to/file.ts`
- `@path/to/dir/`
- `#selection:path:10-20`
- `#sym:path:SymbolName:42`
- `~diff`
- `~staged`
- `~stash:N`
- `~<commit-hash>`

### Existing generation logic

`src/completions/CompletionHelpers.ts` already knows how to build most of these strings for completions:

- file inserts
- directory inserts
- selection inserts
- symbol inserts
- git diff/staged/stash/commit inserts

That file is the best starting point for a shared “reference builder” layer so menu commands do not duplicate syntax formatting and quoting logic.

### Existing menu/command footprint

`package.json` already contributes FlightPath actions to:

- `explorer/context`
- `editor/title`
- `editor/title/context`

Those commands are workflow-file actions (`Run`, `Load`, `Queue`). There is currently no command path for “insert reference into prompt editor”.

### Existing editor/webview behavior

`src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` already handles:

- extension-driven completion responses
- extension-driven context-ref validation
- opening links back into VS Code

But it does not currently expose a safe insertion API for external commands. `editorStore.setPromptText()` can replace the whole prompt, but it is not enough for cursor-aware insertion into the live CodeMirror selection.

---

## 3. VS Code API Findings

Official references used:

- Contribution points / menus: https://code.visualstudio.com/api/references/contribution-points
- SCM menus: https://code.visualstudio.com/api/extension-guides/scm-provider
- When-clause contexts: https://code.visualstudio.com/api/references/when-clause-contexts
- Context menu UX guidance: https://code.visualstudio.com/api/ux-guidelines/context-menus

### Available menu surfaces that matter here

The current VS Code API exposes the relevant menu ids we need:

- `explorer/context`
- `editor/context`
- `editor/lineNumber/context`
- `scm/title`
- `scm/resourceState/context`
- `scm/resourceFolder/context`
- `timeline/item/context`

### Important command-argument behavior

- Explorer menu commands receive the selected `Uri`.
- Editor menu commands receive the current document `Uri`.
- `editor/lineNumber/context` commands also receive the clicked line number.
- SCM resource menu commands receive an array of one or more selected resource states.

### Important limitation

Built-in SCM menus do **not** expose a dedicated “commit history item” context surface. The direct commit-item right-click surface exposed by VS Code is `timeline/item/context`, not `scm/resourceState/context`.

That means:

- changed files/resources belong in SCM menus
- commit hashes belong either in Timeline item menus or in some other picker-driven command

For this plan revision, only the Timeline commit-item path is in scope. SCM title actions for `~diff`, `~staged`, stash, or recent commits are intentionally out of scope.

This is the main API constraint that should shape the implementation plan.

---

## 4. Product Shape

### Recommendation: use a submenu, not a flat command list

Because this feature will appear in several menus, it should contribute a shared submenu:

- `Add to FlightPath`

This avoids polluting Explorer, Editor, and SCM menus with many top-level actions.

### Surface-to-reference mapping

| Surface | User action | Inserted reference |
| --- | --- | --- |
| Explorer file | Right-click file → Add to FlightPath | `@path/to/file` |
| Explorer folder | Right-click folder → Add to FlightPath | `@path/to/folder/` |
| Editor with selection | Right-click selection → Add to FlightPath | `#selection:path:start-end` |
| Editor without selection | Right-click symbol/cursor → Add to FlightPath | `#sym:path:Symbol:line` if resolvable, else fallback |
| SCM changed file(s) | Right-click changed resource(s) → Add to FlightPath | `@path` per selected resource |
| Timeline commit item | Right-click commit item → Add to FlightPath | `~<hash>` |

### Symbol fallback behavior

For the editor context-menu command:

1. If there is a non-empty selection, insert `#selection`.
2. Otherwise try to resolve the symbol at the active cursor/line and insert `#sym`.
3. If symbol resolution fails, fall back to `#selection:path:N-N` for the clicked/current line.

This gives the user something useful even when symbol providers are incomplete.

---

## 5. Architecture

## 5.1 Shared reference-builder layer

Do not hand-build strings in each command.

Recommended extraction:

- either extend `src/completions/CompletionHelpers.ts`
- or extract a new shared helper such as `src/completions/ContextReferenceBuilder.ts`

That layer should own:

- path normalization to workspace-relative form
- quoting paths with spaces
- building `@file`
- building `@dir/`
- building `#selection:path:start-end`
- building `#sym:path:name:line`
- building `~hash`

`CompletionHelpers.ts` should then consume those builders for completions, and the new menu commands should consume the same builders for insertion.

This keeps `ContextExpander` and `FileReferenceParser` as the “parse/expand” source of truth, and the new builder helper as the “generate reference text” source of truth.

## 5.2 Extension-side command service

Add a small extension-side command layer dedicated to “insert into prompt editor” actions.

Recommended file:

- `src/completions/ContextMenuReferenceCommands.ts`

Responsibilities:

- inspect Explorer / editor / SCM / timeline command arguments
- build one or more reference strings
- focus/open the FlightPath dashboard
- send a panel-scoped insertion request to the webview

This should not be spread as ad hoc lambdas through `extension.ts`.

## 5.3 Panel-scoped insertion bridge

Add a focused API on `FlightPathWebviewProvider` for prompt-editor insertion.

Recommended shape:

```ts
enqueuePromptEditorInsert(request: PromptEditorInsertRequest): Promise<void>
```

Key requirements:

- use `this.postMessage(...)` or another panel-scoped send path
- do **not** broadcast through `DashboardBroadcastHub`
- queue pending insert requests until the webview is ready
- call `flightpath.dashboard.focus` before sending when the panel is not visible

This avoids accidentally sending insertion messages to hosted browser clients.

## 5.4 Webview insertion contract

Add a new message type for extension → webview insertion, for example:

- `INSERT_PROMPT_REFERENCES`

Payload should include at least:

- `references: string[]`
- `mode: "insert" | "append"`
- optional `surroundWithNewlines`

### Why this should not just call `setPromptText()`

`CodeMirrorEditor.tsx` owns the live cursor/selection. Replacing the whole prompt text through Zustand would lose the exact insertion point and produce awkward UX.

Recommended flow:

1. `useMessageHandler.ts` receives `INSERT_PROMPT_REFERENCES`
2. webview ensures the editor is in prompt mode
3. `CodeMirrorEditor.tsx` applies a real CodeMirror transaction at the current selection
4. if the editor is not yet mounted, queue the insertion until mount

### Editor target behavior

Recommended default:

- if currently editing a prompt step or final step, insert there
- if currently in new-prompt mode, insert there
- if currently in script-step mode, switch to new-prompt mode before insert

This is simpler than inventing a second destination model.

---

## 6. Concrete Command/Menu Plan

## 6.1 Commands

Recommended command set:

- `flightpath.addExplorerResourceToPromptEditor`
- `flightpath.addEditorContextToPromptEditor`
- `flightpath.addScmResourcesToPromptEditor`
- `flightpath.addTimelineCommitToPromptEditor`

These should be hidden from the Command Palette unless a command is also useful outside the menu flow.

## 6.2 Submenu

Add a shared submenu contribution in `package.json`, for example:

```json
"submenus": [
  {
    "id": "flightpath.addToFlightPath",
    "label": "Add to FlightPath"
  }
]
```

Then contribute that submenu to the relevant menu surfaces instead of individual commands where it improves clarity.

## 6.3 Explorer

Add submenu to `explorer/context`:

- file case: visible when `resourceScheme == file && !explorerResourceIsFolder`
- folder case: visible when `explorerResourceIsFolder`

## 6.4 Editor

Add submenu or direct command to:

- `editor/context`
- optionally `editor/lineNumber/context`

Suggested `when` logic:

- selection command when `editorHasSelection`
- symbol/line command when `resourceScheme == file`

`editor/lineNumber/context` is useful if right-click placement must track the clicked line more reliably than the active selection alone.

## 6.5 SCM

Use SCM resource surfaces only:

- `scm/resourceState/context` and `scm/resourceFolder/context`
  - insert one `@path` per selected changed resource

For SCM resource multi-select, join inserted references with newlines in selection order.

### SCM title

Out of scope for this version.

Rationale:

- `~diff` is fast to type manually
- the user explicitly does not want SCM title actions for working tree or staged diff
- stash and recent-commit pickers add scope without improving the core right-click path materially

## 6.6 Timeline commit items

Add a direct commit-item command on `timeline/item/context`.

Use a `when` clause keyed to Git commit timeline items, for example matching the documented `timelineItem` context pattern:

- `timelineItem =~ /git:file:commit\\b/`

This is the correct built-in right-click surface for commit items.

---

## 7. Git Context Plan

Git-context scope for this version is intentionally narrow:

- in scope: timeline commit item → `~<hash>`
- out of scope: SCM title actions for `~diff`, `~staged`, stash, and recent commits

This keeps the implementation aligned with the requested UX and avoids adding picker-driven git actions that the user does not want.

---

## 8. Insertion UX Rules

Recommended insertion rules:

- single reference: insert at cursor
- multiple references: insert as newline-delimited block
- if the cursor is mid-line and multiple references are inserted, surround with newlines
- preserve current prompt text exactly otherwise
- focus the FlightPath panel after insertion

Do **not** auto-expand references into XML in the editor. The editor should always receive raw reference syntax.

---

## 9. Files Likely Involved

- `package.json`
- `src/extension.ts`
- `src/completions/CompletionHelpers.ts`
- `src/completions/ContextMenuReferenceCommands.ts` or similar new module
- `src/utils/GitUtils.ts`
- `src/ui/FlightPathWebviewProvider.ts`
- `src/ui/WebviewMessageRouter.ts`
- `src/types/DashboardConstants.ts`
- `src/types/WebviewMessageTypes.ts`
- `src/ui/webview-react/hooks/useMessageHandler.ts`
- `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`
- `src/ui/webview-react/components/editor/PromptEditor.tsx`
- `src/ui/webview-react/store/editorStore.ts`

---

## 10. Implementation Order

1. Extract or add shared reference-builder helpers so completions and commands can share syntax generation.
2. Add new extension commands for Explorer, editor, SCM, and timeline surfaces.
3. Add `package.json` submenu and menu contributions.
4. Add panel-scoped insertion API on `FlightPathWebviewProvider`.
5. Add new insertion message type(s) in `DashboardConstants.ts` and typed payloads in `WebviewMessageTypes.ts`.
6. Add webview-side insertion handling with buffering for pre-mount requests.
7. Make `CodeMirrorEditor.tsx` apply live insertion transactions at the current selection.
8. Add tests and manual verification.

---

## 11. Testing Plan

## Unit tests

- reference-builder helpers
- path quoting and workspace-relative normalization
- editor selection → `#selection`
- symbol resolution fallback behavior
- SCM resource array → multiple `@path` refs
- timeline commit reference generation

## Integration tests

- command registration for new menu commands
- extension-to-webview insertion message flow
- panel-not-ready insertion queue

## Manual testing

- Explorer file
- Explorer folder
- editor selection
- editor symbol with and without selection
- SCM changed file
- Timeline commit item
- insertion while editing a queue step
- insertion while editing final step
- insertion while script step is selected
- insertion when the panel is closed

---

## 12. Open Questions

1. Should insertion target the currently edited prompt even when the user is editing the final step, or should all external inserts force new-prompt mode?
2. For SCM changed resources, should the command always insert `@path`, or should there also be a separate “Add Resource Diff” action later?
3. Do we want a single generic submenu label everywhere, or more explicit labels like `Add File to FlightPath` on single-action surfaces?
4. Should `timeline/item/context` be the only commit-hash insertion surface, or do we eventually want a fallback command-palette picker for commits too?

---

## Recommendation

Build this as a **shared reference-generation + panel-scoped insertion** feature, not as a one-off set of menu lambdas.

The most important implementation decisions are:

- reuse the existing reference syntax exactly
- centralize reference string generation
- keep insertion panel-scoped, not broadcast-scoped
- use `timeline/item/context` for commit items, because built-in SCM menus do not expose commit-history entries directly
- leave SCM title git actions out of scope for this version

That approach covers the requested VS Code surfaces, fits the current FlightPath architecture, and avoids duplicating context syntax logic across completions, commands, and the webview.
