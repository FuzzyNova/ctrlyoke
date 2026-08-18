# Script & Branch Name Field Completions Plan

## Problem

Two single-line fields in the dashboard are plain `<input>`s with no completion help:

1. `ScriptConditionEditor.tsx` renders the script command as a plain single-line
   `<input>`. That keeps the form simple, but it means script steps, pre-conditions,
   and end conditions get no help for common commands like `npm test`, `npm run build`,
   `pwsh`, `bash`, `git`, or workspace-specific package scripts.
2. `WorkflowPropertiesPanel.tsx`'s Worktree "Branch" field (`#settings-worktree-branch`,
   ~line 1550) is also a plain `<input>`, with no help finding an existing local branch
   name — despite the field explicitly allowing either an existing or a brand-new branch.

The prompt editor already uses CodeMirror autocomplete for `@`, `#`, `~`, and file-path
references. Both fields above need a smaller, single-line completion surface than that —
plus, since neither is a code editor, a control that behaves exactly like a normal form
input (no newlines, no multi-line affordances) with autocomplete layered on top:

- Script field: workspace npm scripts discovered from the active workspace `package.json`,
  plus common built-in shell commands for bash, zsh, sh, PowerShell, and Windows shells.
- Branch field: local Git branch names discovered from the current repo, filtered by prefix.
- Good keyboard behavior in a one-line form field, shared identically across both fields.
- No runtime execution of user scripts while collecting suggestions; branch listing only
  ever reads refs (`git for-each-ref`), never runs a script or mutates the repo.

Both fields share the same underlying single-line CodeMirror shell (see Architecture) —
this plan builds that shell once and ships two thin, field-specific wrappers on top of it.

---

## Recommendation

Use a dedicated single-line CodeMirror component, shared by both fields, backed by the existing webview completion request pattern.

A native `<datalist>` would be the smallest implementation, but it is a poor fit for this UI:

- Styling is browser-controlled and will not reliably match VS Code webview theme tokens.
- It cannot show command/branch descriptions or details cleanly.
- Matching behavior is inconsistent across Chromium versions.
- It does not give enough control over replacement ranges after partial input like `npm run te`.

CodeMirror is already in the webview bundle and already has working completion plumbing. A one-line CodeMirror field is the more predictable route even though it is a little more code — and building it as one generic shell (see Architecture) means the branch field's autocomplete is nearly free once the script field's is done.

---

## User Experience

Both fields should behave like a normal single-line input:

- Same height and visual treatment as the existing input.
- Enter does not insert a newline.
- Tab/Enter accepts the selected completion.
- Escape closes completions and leaves the field focused.
- Blur saves exactly the text currently in the editor.
- Disabled/read-only state matches the current `disabled` prop.

### Script Suggestions

| Typed text            | Suggestions                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| `npm `                | `npm run <script>`, `npm test`, `npm install`, `npm ci`                         |
| `npm run `            | all scripts from `package.json`                                                 |
| `npm run te`          | matching npm scripts such as `test`, `test:ui`                                  |
| `pnpm `               | `pnpm run <script>`, `pnpm test`, discovered script names                       |
| `yarn `               | `yarn <script>`, `yarn test`, discovered script names                           |
| `git `                | `git status`, `git diff`, `git log`, `git rev-parse`                            |
| `pwsh` / `powershell` | `pwsh -File`, `powershell -ExecutionPolicy Bypass`                              |
| empty field           | high-value starters: `npm test`, `npm run build`, `git status`, shell built-ins |

### Branch Suggestions

| Typed text  | Suggestions                                                                 |
| ----------- | ---------------------------------------------------------------------------- |
| empty field | all local branches, most-recently-committed first (no exclusions — the current branch is listed like any other; `validateBranchName`/`addWorktree` already reject unusable branches) |
| `feat/`     | local branches whose name starts with `feat/`                                |
| `fix-123`   | local branches matching `fix-123` anywhere convenient by prefix filter       |
| no match    | no suggestions shown; typed text is kept as-is (a new branch name)           |

Suggestion items for existing branches carry a `detail` of `"Existing branch"` so users
can tell an exact-match suggestion is not going to create a new branch. There is no
"new branch" suggestion item — typed text that doesn't match anything is simply left as
free text, exactly like today's plain `<input>`.

---

## Architecture

### 1. Reusable Components: `SingleLineCompletionEditor` + `ScriptCommandEditor` + `BranchNameEditor`

Split the CodeMirror wrapper into two layers so the single-line-with-autocomplete
behavior isn't locked to script commands: a generic single-line editor shell, plus a
thin field-specific wrapper per consumer.

**Decision: Reuse `SingleLineCompletionEditor`** for the Worktree "Branch" field too,
rather than replacing that field with a dropdown-plus-"custom"-option control. The
field's own description ("existing **or new** local Git branch") makes creating a new
branch the common case, not an edge case — a dropdown would force an extra "New…"
selection step before typing on that common path, and branch counts in active repos
(dozens to low hundreds) are large enough that a dropdown would need its own type-to-filter
anyway. Autocomplete lets free text and suggestions coexist with zero mode-switching, and
because the shell below is generic, `BranchNameEditor` costs little beyond a small
completion source once `ScriptCommandEditor` exists.

**`src/ui/webview-react/components/shared/SingleLineCompletionEditor.tsx`** (generic, no script knowledge):

- Wraps a CodeMirror 6 `EditorView` in a fixed single-line control.
- Accepts `id`, `value`, `onChange`, `onBlur`, `placeholder`, `disabled`, `className`,
  `aria-label`, `aria-describedby`, and a
  `completionSource: (context: CompletionContext) => Promise<CompletionResult | null>`
  prop — the caller supplies parsing/filtering/request-plumbing, this component only
  owns the editor shell and keybindings.
- **Must reproduce the plain `<input>`'s commit semantics**, because _both_ call sites
  today keep the typed text in local React state (`scriptInput`, `worktreeBranchInput`)
  and commit it only on blur (and on Enter, which blurs). So `onChange` fires per
  keystroke into local state and `onBlur` is the commit hook — do **not** collapse the
  two into a single per-keystroke commit, or every keypress will write a workflow
  mutation.
- `className` passthrough is required, not optional: the two call sites use different
  visual treatments (`text-sm` for the script field; `text-xs font-mono h-7` plus a
  _dynamic_ `fieldValidationBorderClass(...)` border for the branch field), so the shell
  cannot hardcode one class string.
- Configures CodeMirror `autocompletion()` using the injected `completionSource`.
- Prevents multi-line input by translating Enter into completion acceptance (when the
  completion popup is open) and otherwise into blur — matching today's
  `onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}`. Newlines must
  never be insertable, including via paste (strip `\r?\n` from pasted text).
- Preserves the existing input accessibility contract: `id` must land on the focusable
  element so the existing `<label htmlFor>`/`FormField htmlFor` wiring still works, and
  `aria-label` / `aria-describedby` must be forwarded to that same element.
- Owns the shared single-line theme (height, no gutters, no active-line background,
  suggestion tooltip parented to `document.body`) so every consumer gets consistent styling for free.
- Builds that theme on top of the existing `createThemeExtension("input")` from
  `src/ui/webview-react/utils/codemirrorTheme.ts` (already used by `CodeMirrorEditor`'s
  `surface="input"` mode) rather than hand-rolling input colors — only the single-line
  specifics (fixed height, no wrap, no gutters) are new.

**`src/ui/webview-react/components/shared/ScriptCommandEditor.tsx`** (script-specific):

- Thin wrapper around `SingleLineCompletionEditor`.
- Supplies a `completionSource` that posts `SCRIPT_COMPLETIONS_REQUEST` to the extension
  and resolves with the `SCRIPT_COMPLETIONS_RESPONSE` items (see Message Types below).
- Owns nothing about the editor shell itself — that all lives in `SingleLineCompletionEditor`.

`ScriptConditionEditor.tsx` then replaces only the script `<input>` with:

```tsx
<ScriptCommandEditor
  id={`${idPrefix}-script`}
  value={scriptInput}
  onChange={setScriptInput}
  onBlur={() => update({ script: scriptInput })}
  placeholder="npm test"
  disabled={disabled}
  className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
/>
```

Note this keeps the existing `scriptInput` local state and its blur commit — the current
`<input>` already works that way (`onChange` → `setScriptInput`, `onBlur` → `update`,
Enter → blur), and the `useEffect` that resyncs `scriptInput` from `v.script` must keep
working. The rest of `ScriptConditionEditor.tsx` stays unchanged, which means all three
variants (`endCondition`, `preCondition`, `scriptStep`) pick up completions at once.

**`src/ui/webview-react/components/shared/BranchNameEditor.tsx`** (branch-specific):

- Thin wrapper around `SingleLineCompletionEditor`, same shape as `ScriptCommandEditor`.
- Supplies a `completionSource` that posts `BRANCH_LIST_REQUEST` to the extension and
  resolves with the `BRANCH_LIST_RESPONSE` items (see Message Types below). No segment
  parsing is needed — the whole field value is the filter prefix.
- Preserves the same accessibility contract (`id`, `aria-label`, `aria-describedby` for
  `FieldDiagnostic`) that the current `<input id="settings-worktree-branch">` has, since
  `WorkflowPropertiesPanel.tsx` already wires validation diagnostics to that id.

`WorkflowPropertiesPanel.tsx` replaces only the branch `<input>` (~line 1550) with:

```tsx
<BranchNameEditor
  id="settings-worktree-branch"
  aria-label="Worktree branch"
  value={worktreeBranchInput}
  onChange={setWorktreeBranchInput}
  onBlur={() => handleWorktreeFieldChange("branch", worktreeBranchInput)}
  aria-describedby={
    worktreeBranchDiagnostics.length > 0
      ? "settings-worktree-branch-diagnostic"
      : undefined
  }
  className={`w-full px-2 py-1 text-xs bg-input-bg text-input-fg border ${fieldValidationBorderClass(worktreeBranchDiagnostics)} rounded focus:outline-none focus:border-focus-border font-mono h-7`}
/>
```

The dynamic `fieldValidationBorderClass(worktreeBranchDiagnostics)` border must survive
the swap — it is how an invalid branch name is signalled today, and it changes on every
validation update, so it has to flow through the `className` prop rather than being
baked into the shell.

The local-state/onBlur-commit pattern (`worktreeBranchInput` state, commit on blur) and
the `FieldDiagnostic` validation display stay exactly as they are today — only the
`<input>` itself is swapped out. `PropertiesDrawer.tsx` has no equivalent worktree
branch field today, so no second call site needs updating.

### 2. Message Types

Add shared constants in `src/types/DashboardConstants.ts`:

```typescript
SCRIPT_COMPLETIONS_REQUEST: "scriptCompletionsRequest",
SCRIPT_COMPLETIONS_RESPONSE: "scriptCompletionsResponse",
BRANCH_LIST_REQUEST: "branchListRequest",
BRANCH_LIST_RESPONSE: "branchListResponse",
```

Add typed payloads in `src/types/WebviewMessageTypes.ts` if the surrounding message union needs to become stricter:

```typescript
export interface ScriptCompletionsRequestMessage {
  type: typeof MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST;
  text: string;
  position: number;
  seq: number;
}

export interface ScriptCompletionsResponseMessage {
  type: typeof MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE;
  items: ScriptCompletionItem[];
  from: number;
  seq: number;
}

export interface BranchListRequestMessage {
  type: typeof MESSAGE_TYPES.BRANCH_LIST_REQUEST;
  filterText: string;
  seq: number;
}

export interface BranchListResponseMessage {
  type: typeof MESSAGE_TYPES.BRANCH_LIST_RESPONSE;
  items: PlainCompletionItem[];
  seq: number;
}
```

`BranchListResponseMessage` reuses the existing `PlainCompletionItem` shape from
`src/completions/CompletionHelpers.ts` rather than introducing a new item type — branch
completions don't need a replacement range (the whole field is always the filter/replace
target), so `PlainCompletionItem`'s `label`/`insertText`/`detail` is a complete fit.
Note `PlainCompletionItem.kind` is **required** (`vscode.CompletionItemKind`), so branch
items must set one — use `vscode.CompletionItemKind.Reference`, matching how
`getGitChangeCompletions` types its git-derived items.

### 3. Extension-Side Completion Services

Create `src/completions/ScriptCommandCompletionHelpers.ts` (details below) and
`src/completions/BranchCompletionHelpers.ts`.

`BranchCompletionHelpers.ts` responsibilities:

- Resolve the workspace/repo root the same way `OPEN_GIT_CHANGE` does today
  (`vscode.workspace.workspaceFolders` → `getVsCodeWorkspaceRoot()`), then call a new
  `listLocalBranches(repoRoot)` helper added to `src/utils/GitUtils.ts` — following the
  existing `execGit`/`currentBranch`/`localBranchExists` conventions in that file, e.g.:
  ```typescript
  export async function listLocalBranches(repoRoot: string): Promise<string[]> {
    const { stdout } = await execGit([
      "-C",
      repoRoot,
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  ```
- Cache the branch list with a short time-based TTL (10s), mirroring `getGitChangeCompletions`'s
  `gitCache`/`GIT_CACHE_DURATION_MS` pattern in `CompletionHelpers.ts` — no `FileSystemWatcher`
  needed for this source (see Open Questions).
- Filter cached branch names by the current field text (case-insensitive substring or
  prefix match — prefix match preferred, see Open Questions) and map to `PlainCompletionItem[]`
  with `detail: "Existing branch"`.
- Never write to the repo and never run anything other than the read-only `for-each-ref` call.

Both helpers stay framework-agnostic like `CompletionHelpers.ts` (pure functions taking a
workspace/repo root and filter text, returning items — no CodeMirror or webview imports).

`ScriptCommandCompletionHelpers.ts` responsibilities:

- Read workspace `package.json` files without executing anything.
- Extract `scripts` object keys and optional script command strings.
- Return command-oriented completions for:
  - `npm run <script>`
  - `npm test` when a `test` script exists
  - `npm run build` when a `build` script exists
  - equivalent `pnpm` and `yarn` forms
- Merge in curated shell command completions.
- Compute replacement range for the current command segment.
- Keep output framework-agnostic like `CompletionHelpers.ts`.

Suggested item shape:

```typescript
export interface ScriptCommandCompletionItem {
  label: string;
  insertText: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  kind?: number;
}
```

### 4. Router Handlers

Register both in `registerEditorSupport()` in `src/ui/WebviewMessageRouter.ts`, right
next to the existing `REQUEST_COMPLETIONS` entry, and delegate to
`PromptEditorSupportService` (`src/ui/PromptEditorSupportService.ts`) — that service
already owns `handleCompletionRequest`, so the two new sources belong there rather than
as new inline router methods:

```typescript
table.set(MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST, async (message, ctx) => {
  await this.promptEditorSupport.handleScriptCompletionRequest(
    ctx,
    message.text,
    message.position,
    message.seq
  );
});

table.set(MESSAGE_TYPES.BRANCH_LIST_REQUEST, async (message, ctx) => {
  await this.promptEditorSupport.handleBranchListRequest(
    ctx,
    message.filterText,
    message.seq
  );
});
```

**There is no `this.emitMessage` on the router.** Responses go back to the *requesting
client only*, via the `WebviewClientContext` (`src/ui/WebviewClientContext.ts`) that the
dispatch table passes as the second handler argument — this is what makes the flow work
for the hosted browser dashboard as well as the VS Code panel, since multiple clients can
be connected at once. Mirror `emitCompletionsResponse` in `PromptEditorSupportService`:

```typescript
ctx.emit({
  type: MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE,
  items,
  from,
  seq,
});
```

The branch handler resolves the repo root (same helper `OPEN_GIT_CHANGE` uses), calls
`getBranchCompletions(repoRoot, filterText)`, and emits:

```typescript
ctx.emit({
  type: MESSAGE_TYPES.BRANCH_LIST_RESPONSE,
  items,
  seq,
});
```

Both handlers must swallow errors and emit an empty `items` array on failure, exactly as
`handleCompletionRequest` does today — a completion source must never surface an error
toast or leave the dropdown hanging on an unresolved promise.

Both stay separate from `REQUEST_COMPLETIONS` because prompt completions, shell command completions, and branch completions all have different parsing rules and item sources.

---

## Completion Sources

### Npm Scripts

Start with the first workspace folder and its root `package.json`. Later, support multi-root and nested package discovery if needed.

Rules:

- Only read `package.json`; do not run `npm`, `pnpm`, or `yarn`.
- Ignore malformed JSON and return built-ins instead of failing the UI.
- Use `vscode.workspace.fs.readFile` or `fs.promises.readFile` consistently with existing extension-side helpers.
- Cache results per package file path and invalidate with a `FileSystemWatcher` for `**/package.json`.

Initial output examples:

| Script key | Completion labels                                    |
| ---------- | ---------------------------------------------------- |
| `test`     | `npm test`, `npm run test`, `pnpm test`, `yarn test` |
| `build`    | `npm run build`, `pnpm build`, `yarn build`          |
| `test:ui`  | `npm run test:ui`, `pnpm test:ui`, `yarn test:ui`    |

Prefer npm-first sorting because `npm` is universal in Node projects, but include pnpm/yarn forms because workspaces often use those package managers.

### Shell Built-Ins and Common Commands

Create a static list grouped by shell family:

- POSIX/common: `cd`, `pwd`, `ls`, `cat`, `echo`, `grep`, `find`, `test`, `true`, `false`, `mkdir`, `rm`, `cp`, `mv`
- Bash/zsh helpers: `source`, `export`, `set -e`, `[[ ... ]]`
- PowerShell: `pwsh`, `powershell`, `Get-ChildItem`, `Get-Content`, `Test-Path`, `Select-String`, `New-Item`, `Remove-Item`
- Windows shell/common tools: `cmd /c`, `where`, `dir`
- Developer tools: `node`, `npx`, `npm`, `pnpm`, `yarn`, `git`

Descriptions should be concise and user-facing, for example:

- `npm run test:ui` — `package.json script: vitest run ...`
- `Test-Path` — `PowerShell: check whether a path exists`
- `git diff` — `Show unstaged changes`

Avoid dangerous commands as top-level high-priority suggestions. If included at all, destructive commands like `rm`, `Remove-Item`, and `git clean` should have low priority and no aggressive snippets.

### Local Git Branches

- Source: `listLocalBranches(repoRoot)` in `GitUtils.ts` (`git for-each-ref refs/heads`,
  sorted by most-recently-committed). Local branches only — see Open Questions for why
  remote-tracking branches are deliberately excluded from v1.
- No segment parsing: the entire field value is the filter string, and accepting a
  suggestion replaces the entire field value (unlike script's segment-aware replacement).
- Filtering is prefix-based against branch short names (`feat/` matches `feat/foo`,
  `feat/bar`); see Open Questions for whether to widen this to substring matching.
- Cached for 10s per repo root, same TTL as `getGitChangeCompletions`'s existing cache.

---

## Parsing and Replacement Rules

The first version can use pragmatic token parsing without becoming a full shell parser.

Input model:

- Treat the whole field as one command line.
- Complete the command segment containing the cursor.
- Split pipeline/control boundaries on `|`, `&&`, `||`, and `;` for determining the current segment.
- Preserve text before and after the segment.
- Do not try to complete inside quoted strings in the first pass.

Replacement examples:

| Current text       | Cursor context | Replacement range  | Completion insert   |
| ------------------ | -------------- | ------------------ | ------------------- |
| `npm run te`       | after `te`     | `te`               | `test:ui` or `test` |
| `npm te`           | after `te`     | `npm te` segment   | `npm test`          |
| `git st`           | after `st`     | `git st` segment   | `git status`        |
| `echo ok && npm r` | after `r`      | after `&&` segment | `npm run ...`       |

This should live in a pure helper so edge cases can be unit-tested without CodeMirror or VS Code.

---

## Styling

Reuse `ScriptConditionEditor.tsx` input classes as the visual target:

```text
w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50
```

CodeMirror theme requirements:

- Single-line height close to the current input.
- No gutters.
- No active line background unless it reads like normal input focus.
- Tooltip parent should be `document.body`, following `CodeMirrorEditor.tsx`, so suggestions are not clipped by drawer/panel overflow.
- Use VS Code suggest widget CSS variables for autocomplete styling.

Consider extracting shared CodeMirror autocomplete tooltip styling from `CodeMirrorEditor.tsx` only if duplication becomes meaningful. The single-line theme itself lives once in `SingleLineCompletionEditor.tsx` (see Architecture) so `ScriptCommandEditor.tsx` and `BranchNameEditor.tsx` both get it for free without duplicating theme code.

---

## Open Questions & Recommendations

These are the remaining decisions worth settling before implementation starts. Each has
a recommendation; flag if you want a different call before work begins.

1. **Include remote-tracking branches (`origin/foo`) in branch suggestions?**
   Recommendation: **no, local only for v1.** The field's own description says "local
   Git branch," `addWorktree` operates on local branches, and mixing in remote refs adds
   a whole extra category of "detail" text (checkout-and-track semantics) for a feature
   that's about picking/creating a local branch. Revisit only if users ask for it.

2. **Filter local branches whose name is currently checked out elsewhere (already in a worktree)?**
   Recommendation: **not in v1.** `WorktreesSection.tsx` already surfaces "in use" state
   for existing worktrees, and `addWorktree`/`validateBranchName` already error clearly if
   a branch can't be used. Filtering suggestions ahead of that would duplicate validation
   logic in two places for a rare conflict. Track as a Future Extension instead.

3. **Cache invalidation strategy for the branch list — time-based TTL vs. `FileSystemWatcher`?**
   Recommendation: **time-based TTL (10s)**, matching the existing `gitCache` pattern in
   `CompletionHelpers.ts`'s `getGitChangeCompletions`. A watcher on `.git/refs/heads/**`
   (plus `packed-refs`) is more "correct" but is new plumbing this codebase doesn't already
   have for git-derived completions, and a 10s staleness window on a field that's edited
   for at most a few seconds at a time is unnoticeable. Keep the watcher idea in Future
   Extensions if staleness ever becomes a real complaint.

4. **Branch filter matching — prefix-only or substring?**
   Recommendation: **prefix match** on the branch short name for v1 (simpler, predictable,
   matches how `npm run <script>` filtering already works for the script field). Substring
   matching (so `123` also matches `fix-123-foo`) is a reasonable Future Extension if
   prefix-only turns out to feel too strict once real branch-naming conventions are seen.

5. **One PR or two?**
   Recommendation: **land `SingleLineCompletionEditor` + `ScriptCommandEditor` first**
   (it's the larger, riskier piece — segment parsing, npm script discovery, shell command
   list), get it merged, then land `BranchNameEditor` as a small follow-up PR that only
   adds the generic editor's second consumer. This keeps review sizes reasonable without
   changing anything about the combined plan/design captured here.

6. **Should `BranchNameEditor` also apply to the worktree "Base" field?**
   Recommendation: **no — out of scope for this plan.** "Base" accepts any Git ref (branch,
   tag, or commit), not just local branch names, so it needs a different/broader completion
   source. Worth its own backlog item if picked up later; don't conflate it with this plan's
   "Branch" field, which is unambiguously a local-branch-only field.

If any of these recommendations don't match your intent, say so before implementation starts — everything else in this plan is ready to build as written.

---

## Implementation Steps

Two phases, landed as two PRs per recommendation #5 above — Phase A must merge before Phase B starts, since Phase B only adds a second thin consumer of the shell Phase A builds.

### Phase A — Shared shell + Script completions

1. Add `SCRIPT_COMPLETIONS_REQUEST` and `SCRIPT_COMPLETIONS_RESPONSE` in `src/types/DashboardConstants.ts`.

2. Create `src/completions/ScriptCommandCompletionHelpers.ts` with:
   - package script discovery
   - static command list
   - segment parsing
   - completion filtering and sorting

3. Add `handleScriptCompletionRequest` to `src/ui/PromptEditorSupportService.ts` (replying
   via `ctx.emit`, mirroring `handleCompletionRequest`/`emitCompletionsResponse`), and
   register `SCRIPT_COMPLETIONS_REQUEST` in `registerEditorSupport()` in
   `src/ui/WebviewMessageRouter.ts`.

4. Create `src/ui/webview-react/components/shared/SingleLineCompletionEditor.tsx` (generic
   single-line CodeMirror shell: keybindings, theme, `completionSource` prop).

5. Create `src/ui/webview-react/components/shared/ScriptCommandEditor.tsx` as a thin
   wrapper supplying the script `completionSource` on top of step 4.

6. Replace the script `<input>` in `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx` with `ScriptCommandEditor`.

7. Add focused tests:
   - Pure parser/completion tests for `ScriptCommandCompletionHelpers`
   - Webview component test for `SingleLineCompletionEditor` (Enter/Escape/Blur, no multiline, disabled state)
   - Webview component test for `ScriptCommandEditor` basic rendering and `onChange`
   - Existing `ScriptConditionEditor` test coverage if present, or a narrow new test proving script edits still call `onChange`

8. Run the gate:

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` is the full gate: its `pretest` hook runs `npm run compile` + `compile-tests`, then it runs the VS Code extension-host suite (which is where the new `src/test/unit/*` tests live) followed by `npm run test:ui`. Use `npm run test:ui` alone only for a fast inner loop on webview-only edits. Never run `npm run test:harness`.

### Phase B — Branch completions (on top of Phase A)

9. Add `listLocalBranches(repoRoot)` to `src/utils/GitUtils.ts` (read-only `for-each-ref`, following the `execGit`/`currentBranch` conventions already in that file).

10. Add `BRANCH_LIST_REQUEST` and `BRANCH_LIST_RESPONSE` in `src/types/DashboardConstants.ts`.

11. Create `src/completions/BranchCompletionHelpers.ts`: resolve repo root, call `listLocalBranches`, cache with a 10s TTL (mirroring `getGitChangeCompletions`'s `gitCache`), filter by prefix, map to `PlainCompletionItem[]` with `detail: "Existing branch"`.

12. Add `handleBranchListRequest` to `src/ui/PromptEditorSupportService.ts` and register
    `BRANCH_LIST_REQUEST` in `registerEditorSupport()` in `src/ui/WebviewMessageRouter.ts`.

13. Create `src/ui/webview-react/components/shared/BranchNameEditor.tsx` as a thin wrapper supplying the branch `completionSource` on top of `SingleLineCompletionEditor`.

14. Replace the branch `<input id="settings-worktree-branch">` in `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` (~line 1550) with `BranchNameEditor`, preserving the existing `worktreeBranchInput` state, `onBlur` commit, and `FieldDiagnostic` wiring.

15. Add focused tests:
    - Pure tests for `BranchCompletionHelpers` (filtering, cache TTL, no-repo/no-branches fallbacks)
    - Webview component test for `BranchNameEditor` basic rendering and `onChange`
    - A narrow `WorkflowPropertiesPanel` test proving the branch field still commits on blur and still surfaces `FieldDiagnostic` errors

16. Run the same gate as step 8 (`npm run typecheck`, `npm run lint`, `npm test`).

| File                                                                       | Action | Purpose                                               |
| -------------------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| `src/types/DashboardConstants.ts`                                          | Modify | Add script + branch completion message constants      |
| `src/types/WebviewMessageTypes.ts`                                         | Modify | Add request/response payload types if needed          |
| `src/completions/ScriptCommandCompletionHelpers.ts`                        | Create | Workspace script and shell command completion logic   |
| `src/completions/BranchCompletionHelpers.ts`                               | Create | Local branch discovery, caching, and filtering logic  |
| `src/utils/GitUtils.ts`                                                    | Modify | Add `listLocalBranches(repoRoot)`                      |
| `src/ui/WebviewMessageRouter.ts`                                           | Modify | Route script and branch completion requests from the webview |
| `src/ui/PromptEditorSupportService.ts`                                     | Modify | Handle both requests and reply via `ctx.emit`          |
| `src/ui/webview-react/components/shared/index.ts`                          | Modify | Barrel-export the three new components                 |
| `src/ui/webview-react/components/shared/SingleLineCompletionEditor.tsx`    | Create | Generic single-line CodeMirror input + autocomplete shell |
| `src/ui/webview-react/components/shared/ScriptCommandEditor.tsx`           | Create | Script-specific completion source on top of the generic editor |
| `src/ui/webview-react/components/shared/BranchNameEditor.tsx`              | Create | Branch-specific completion source on top of the generic editor |
| `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`         | Modify | Replace plain script input with `ScriptCommandEditor` |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx`       | Modify | Replace plain branch input with `BranchNameEditor`    |
| `src/ui/webview-react/test/components/shared/SingleLineCompletionEditor.test.tsx` | Create | Generic editor behavior tests (Enter/Escape/Blur, no multiline) |
| `src/ui/webview-react/test/components/shared/ScriptCommandEditor.test.tsx` | Create | Script completion source tests                        |
| `src/ui/webview-react/test/components/shared/BranchNameEditor.test.tsx`   | Create | Branch completion source tests                        |
| `src/test/unit/ScriptCommandCompletionHelpers.test.ts`              | Create | Extension-side parser/completion tests                |
| `src/test/unit/BranchCompletionHelpers.test.ts`                    | Create | Extension-side branch filtering/caching tests          |

---

## Edge Cases

### Script Field

| Scenario                           | Expected behavior                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| No workspace folder                 | Show static shell/common command completions only                                               |
| Missing `package.json`               | Show static shell/common command completions only                                               |
| Malformed `package.json`             | Log a warning and continue with built-ins                                                       |
| Empty `scripts` object               | Show built-ins and package manager base commands                                                |
| User types after `&&`, `\|\|`, `\|`, or `;` | Complete only the current command segment                                                |
| User is editing middle of command    | Preserve text before and after the replacement range                                            |
| Disabled editor                      | No editing and no completion requests                                                            |
| Multiple package managers            | Suggest npm, pnpm, and yarn forms; sorting can prefer detected lockfile later                    |
| Very large `package.json`            | Cache parsed scripts and avoid reading on every keystroke                                        |
| Browser-hosted dashboard client      | Completion request still routes through the extension/server client context where available     |

### Branch Field

| Scenario                             | Expected behavior                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| No workspace folder / not a Git repo   | No suggestions; field behaves like today's plain `<input>`                                  |
| Repo with zero local branches          | No suggestions; typed text is kept as free text                                             |
| Typed text matches no branch           | No suggestions shown; typed text is preserved as-is (creating a new branch)                  |
| Typed text exactly matches a branch    | Suggestion still shown with `detail: "Existing branch"` so the user can confirm the match    |
| Disabled editor                        | No editing and no completion requests                                                       |
| Branch list changes mid-session (checkout/create elsewhere) | Suggestions may be up to 10s stale (see Open Questions #3); next keystroke after TTL expiry refreshes |
| Detached HEAD / no current branch      | Doesn't affect suggestions — `listLocalBranches` lists refs, not current HEAD state          |
| Browser-hosted dashboard client        | Completion request still routes through the extension/server client context where available |

---

## Future Extensions

- Detect package manager from lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) and sort matching commands first.
- Discover nested workspace packages from npm/pnpm/yarn workspaces.
- Add completions for local `.ctrlyoke/scripts/*` files.
- Add variable completions for `CTRLYOKE_VAR_*` if workflow vars are present.
- Add shell-specific filtering based on the configured terminal shell.
- Add snippets for common validation patterns like `npm test && npm run lint`.
- Surface package script descriptions if the project adopts a convention for comments or metadata.
- Include remote-tracking branches in branch suggestions (see Open Questions #1).
- Filter out branches already checked out in another worktree from branch suggestions (see Open Questions #2).
- Switch branch-list caching to a `FileSystemWatcher` on `.git/refs/heads/**` if the 10s TTL ever proves noticeably stale (see Open Questions #3).
- Widen branch filtering from prefix-only to substring matching (see Open Questions #4).
- Extend a Git-ref completion source to the worktree "Base" field, which accepts branches, tags, or commits (see Open Questions #6).

---

## Non-Goals

- Running package manager commands to discover scripts.
- Full shell parsing, quoting, glob expansion, or command validation.
- Blocking save/run when a command is not recognized.
- Replacing the prompt editor's existing `REQUEST_COMPLETIONS` flow.
- Adding AI-generated command suggestions.
- Running any git command that writes to the repo while collecting branch suggestions (read-only `for-each-ref` only).
- Replacing the "Branch" input's free-text behavior with a constrained dropdown/select.
- Adding completion support to the worktree "Base" field (different ref-type scope; tracked as a Future Extension).
