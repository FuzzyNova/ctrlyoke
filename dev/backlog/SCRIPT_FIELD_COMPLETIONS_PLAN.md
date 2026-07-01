# Script Field Command Completions Plan

## Problem

`ScriptConditionEditor.tsx` renders the script command as a plain single-line `<input>`. That keeps the form simple, but it means script steps, pre-conditions, and end conditions get no help for common commands like `npm test`, `npm run build`, `pwsh`, `bash`, `git`, or workspace-specific package scripts.

The prompt editor already uses CodeMirror autocomplete for `@`, `#`, `~`, and file-path references. The script field needs a smaller, command-focused completion surface:

- Workspace npm scripts discovered from the active workspace `package.json`
- Common built-in shell commands for bash, zsh, sh, PowerShell, and Windows shells
- Good keyboard behavior in a one-line form field
- No runtime execution of user scripts while collecting suggestions

---

## Recommendation

Use a dedicated single-line CodeMirror component for script commands, backed by the existing webview completion request pattern.

A native `<datalist>` would be the smallest implementation, but it is a poor fit for this UI:

- Styling is browser-controlled and will not reliably match VS Code webview theme tokens.
- It cannot show command descriptions, categories, or npm script details cleanly.
- Matching behavior is inconsistent across Chromium versions.
- It does not give enough control over replacement ranges after partial input like `npm run te`.

CodeMirror is already in the webview bundle and already has working completion plumbing. A one-line CodeMirror field is the more predictable route even though it is a little more code.

---

## User Experience

The script field should behave like a normal single-line input:

- Same height and visual treatment as the existing input.
- Enter does not insert a newline.
- Tab/Enter accepts the selected completion.
- Escape closes completions and leaves the field focused.
- Blur saves exactly the text currently in the editor.
- Disabled/read-only state matches the current `disabled` prop.

Suggested completion examples:

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

---

## Architecture

### 1. Reusable Component: `ScriptCommandEditor`

Create `src/ui/webview-react/components/shared/ScriptCommandEditor.tsx`.

Responsibilities:

- Wrap a CodeMirror 6 `EditorView` in a fixed single-line control.
- Accept `id`, `value`, `onChange`, `placeholder`, and `disabled`.
- Use CodeMirror `autocompletion()` with a script-specific completion source.
- Post completion requests to the extension using new message types.
- Prevent multi-line input by translating Enter into completion acceptance or blur/no-op.
- Preserve the existing input accessibility contract where possible.

`ScriptConditionEditor.tsx` then replaces only the script `<input>` with:

```tsx
<ScriptCommandEditor
  id={`${idPrefix}-script`}
  value={v.script ?? ""}
  onChange={(script) => update({ script })}
  placeholder="npm test"
  disabled={disabled}
/>
```

The rest of `ScriptConditionEditor.tsx` stays unchanged.

### 2. Message Types

Add shared constants in `src/types/DashboardConstants.ts`:

```typescript
SCRIPT_COMPLETIONS_REQUEST: "scriptCompletionsRequest",
SCRIPT_COMPLETIONS_RESPONSE: "scriptCompletionsResponse",
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
```

### 3. Extension-Side Completion Service

Create `src/completions/ScriptCommandCompletionHelpers.ts`.

Responsibilities:

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

### 4. Router Handler

Add a handler in `src/ui/WebviewMessageRouter.ts`:

```typescript
table.set(MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST, async (message) => {
  await this.handleScriptCompletionRequest(
    message.text,
    message.position,
    message.seq
  );
});
```

The handler should call `getScriptCommandCompletions()` and emit:

```typescript
this.emitMessage({
  type: MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE,
  items,
  from,
  seq,
});
```

Keep this separate from `REQUEST_COMPLETIONS` because prompt completions and shell command completions have different parsing rules and item sources.

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

Consider extracting shared CodeMirror autocomplete tooltip styling from `CodeMirrorEditor.tsx` only if duplication becomes meaningful. For the first implementation, a small local theme in `ScriptCommandEditor.tsx` is acceptable.

---

## Implementation Steps

1. Add `SCRIPT_COMPLETIONS_REQUEST` and `SCRIPT_COMPLETIONS_RESPONSE` in `src/types/DashboardConstants.ts`.

2. Create `src/completions/ScriptCommandCompletionHelpers.ts` with:
   - package script discovery
   - static command list
   - segment parsing
   - completion filtering and sorting

3. Add webview router support in `src/ui/WebviewMessageRouter.ts`.

4. Create `src/ui/webview-react/components/shared/ScriptCommandEditor.tsx`.

5. Replace the script `<input>` in `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx` with `ScriptCommandEditor`.

6. Add focused tests:
   - Pure parser/completion tests for `ScriptCommandCompletionHelpers`
   - Webview component test for `ScriptCommandEditor` basic rendering and `onChange`
   - Existing `ScriptConditionEditor` test coverage if present, or a narrow new test proving script edits still call `onChange`

7. Run:

```bash
npm run typecheck
npm run test:ui
```

Run `npm run compile` if router/type changes touch extension-side compilation in a way not covered by `typecheck`.

---

## Files to Create or Modify

| File                                                                       | Action | Purpose                                               |
| -------------------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| `src/types/DashboardConstants.ts`                                          | Modify | Add script completion message constants               |
| `src/types/WebviewMessageTypes.ts`                                         | Modify | Add request/response payload types if needed          |
| `src/completions/ScriptCommandCompletionHelpers.ts`                        | Create | Workspace script and shell command completion logic   |
| `src/ui/WebviewMessageRouter.ts`                                           | Modify | Route script completion requests from the webview     |
| `src/ui/webview-react/components/shared/ScriptCommandEditor.tsx`           | Create | Single-line CodeMirror command input                  |
| `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`         | Modify | Replace plain script input with `ScriptCommandEditor` |
| `src/ui/webview-react/test/components/shared/ScriptCommandEditor.test.tsx` | Create | Component behavior tests                              |
| `src/test/completions/ScriptCommandCompletionHelpers.test.ts`              | Create | Extension-side parser/completion tests                |

---

## Edge Cases

| Scenario                          | Expected behavior                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| No workspace folder               | Show static shell/common command completions only                                           |
| Missing `package.json`            | Show static shell/common command completions only                                           |
| Malformed `package.json`          | Log a warning and continue with built-ins                                                   |
| Empty `scripts` object            | Show built-ins and package manager base commands                                            |
| User types after `&&` or `        | `                                                                                           | Complete only the current command segment |
| User is editing middle of command | Preserve text before and after the replacement range                                        |
| Disabled editor                   | No editing and no completion requests                                                       |
| Multiple package managers         | Suggest npm, pnpm, and yarn forms; sorting can prefer detected lockfile later               |
| Very large package.json           | Cache parsed scripts and avoid reading on every keystroke                                   |
| Browser-hosted dashboard client   | Completion request still routes through the extension/server client context where available |

---

## Future Extensions

- Detect package manager from lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) and sort matching commands first.
- Discover nested workspace packages from npm/pnpm/yarn workspaces.
- Add completions for local `.ctrlyoke/scripts/*` files.
- Add variable completions for `CTRLYOKE_VAR_*` if workflow vars are present.
- Add shell-specific filtering based on the configured terminal shell.
- Add snippets for common validation patterns like `npm test && npm run lint`.
- Surface package script descriptions if the project adopts a convention for comments or metadata.

---

## Non-Goals

- Running package manager commands to discover scripts.
- Full shell parsing, quoting, glob expansion, or command validation.
- Blocking save/run when a command is not recognized.
- Replacing the prompt editor's existing `REQUEST_COMPLETIONS` flow.
- Adding AI-generated command suggestions.
