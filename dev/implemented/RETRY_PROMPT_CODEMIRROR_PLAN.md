# Retry Prompt CodeMirror End Condition Mode Plan

## Problem

The end condition retry prompt in `ScriptConditionEditor.tsx` is a plain `<textarea>`, but it is semantically a full AI prompt. It should support the same authoring features as the main `CodeMirrorEditor.tsx` prompt editor:

- `@` file and directory completions
- `#` selection and symbol completions
- `~` git change completions
- file-reference decorations and Ctrl/Cmd-click open behavior
- spell checking
- search, history, selection highlighting, line wrapping, and VS Code theme integration

It also needs one end-condition-specific feature: autocomplete after `{` for retry template placeholders supported by `EndConditionEvaluator.buildRetryPrompt()`.

Recommended runtime placeholders are:

| Placeholder       | Runtime value                                             |
| ----------------- | --------------------------------------------------------- |
| `{stdout}`        | trimmed stdout from the validation script                 |
| `{stderr}`        | trimmed stderr from the validation script                 |
| `{expected}`      | configured expected value                                 |
| `{actual}`        | actual comparison value (resolved from compareSource)     |
| `{exitCode}`      | numeric exit code from the validation script              |
| `{compareSource}` | comparison source: `stdout`, `stderr`, `exitCode`, `auto` |

Note: the current UI hint says `Use {error} placeholder`, but `EndConditionEvaluator.buildRetryPrompt()` does not replace `{error}`. The evaluator currently supports `{scriptOutput}` and `{errorOutput}`; because FlightPath is still pre-release, this plan intentionally renames those two placeholders to `{stdout}` and `{stderr}` instead of preserving the older names.

---

## Recommendation

Extend the existing `CodeMirrorEditor` into a reusable prompt editor with an explicit mode:

```typescript
type CodeMirrorEditorMode = "prompt" | "endCondition";
```

`prompt` mode keeps today’s behavior. `endCondition` mode keeps all prompt-editor features and adds `{...}` placeholder completions. This avoids creating a second prompt editor that drifts from the main editor over time.

The retry prompt field should use this mode instead of a textarea:

```tsx
<CodeMirrorEditor
  mode="endCondition"
  value={v.retryPrompt ?? ""}
  onChange={(retryPrompt) => update({ retryPrompt })}
  placeholder={"Validation failed: {stderr}\n\nPlease fix the issues."}
  affUri={affUri}
  dicUri={dicUri}
  readOnly={disabled}
  minHeightClassName="min-h-[96px]"
/>
```

The exact prop names can change during implementation, but the important point is that the retry prompt uses the same CodeMirror editor pipeline as the main prompt editor.

---

## Design

### 1. Add Editor Mode to `CodeMirrorEditor`

Modify `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`:

```typescript
export type CodeMirrorEditorMode = "prompt" | "endCondition";

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  affUri: string;
  dicUri: string;
  readOnly?: boolean;
  mode?: CodeMirrorEditorMode;
  minHeightClassName?: string;
  onRun?: () => void;
  onQueue?: () => void;
}
```

Default `mode` to `"prompt"` so existing call sites do not change behavior.

`endCondition` mode should:

- Include the existing `customCompletions` source for `@`, `#`, and `~`.
- Include the existing `pathCompletions` source.
- Add a local `retryPlaceholderCompletions` source for `{`.
- Keep link decorations, file reference decorations, Ctrl/Cmd-click open handling, spell checking, history, search, and theming.
- Disable prompt execution shortcuts unless `onRun` or `onQueue` are provided.

### 2. Add Placeholder Completion Source

Implement a new local completion source in `CodeMirrorEditor.tsx`, or move it to a small helper if the logic gets noisy.

Suggested placeholder metadata:

```typescript
const RETRY_PROMPT_PLACEHOLDERS = [
  {
    label: "stdout",
    apply: "stdout}",
    detail: "stdout",
    info: "Validation script stdout",
  },
  {
    label: "stderr",
    apply: "stderr}",
    detail: "stderr",
    info: "Validation script stderr",
  },
  {
    label: "expected",
    apply: "expected}",
    detail: "expected",
    info: "Configured expected value",
  },
  {
    label: "actual",
    apply: "actual}",
    detail: "actual",
    info: "Actual comparison value (resolved from compareSource)",
  },
  {
    label: "exitCode",
    apply: "exitCode}",
    detail: "exitCode",
    info: "Numeric exit code from the validation script",
  },
  {
    label: "compareSource",
    apply: "compareSource}",
    detail: "compareSource",
    info: "Comparison source used: stdout, stderr, exitCode, or auto",
  },
] as const;
```

Completion behavior:

- Trigger when the user types `{`.
- Continue filtering while they type `{scr`, `{error`, etc.
- Replace only the text after `{`, leaving the opening brace in the document.
- Insert the closing `}` as part of the completion.
- Do not trigger if a space or closing brace appears between `{` and the cursor.
- Use CodeMirror type `"variable"` or `"keyword"` so placeholder items are visually distinct.

Pseudo-source:

```typescript
const retryPlaceholderCompletions = useCallback(
  (context) => {
    if (mode !== "endCondition") return null;

    const line = context.state.doc.lineAt(context.pos);
    const textBefore = line.text.slice(0, context.pos - line.from);
    const openBraceIndex = textBefore.lastIndexOf("{");
    if (openBraceIndex === -1) return null;

    const afterBrace = textBefore.slice(openBraceIndex + 1);
    if (/[\s}]/.test(afterBrace)) return null;

    const from = line.from + openBraceIndex + 1;
    if (from === context.pos && !context.explicit) {
      // This still allows activateOnTyping after "{" because the trigger caused it.
    }

    return {
      from,
      options: RETRY_PROMPT_PLACEHOLDERS.map((item) => ({
        label: item.label,
        apply: item.apply,
        type: "variable",
        detail: item.detail,
        info: item.info,
        boost: 1000,
      })),
    };
  },
  [mode]
);
```

The implementation should be tested against the actual CodeMirror behavior because `activateOnTyping` can differ slightly between typed trigger characters and explicit Ctrl+Space.

### 3. Avoid Completion Resolver Collisions

`CodeMirrorEditor` currently has one pending completion resolver and one `completionSeqRef` for extension-backed completions. Placeholder completions are local and synchronous, so they should not use the pending resolver.

Recommended override order:

```typescript
autocompletion({
  override:
    mode === "endCondition"
      ? [retryPlaceholderCompletions, customCompletions, pathCompletions]
      : [customCompletions, pathCompletions],
  activateOnTyping: true,
  closeOnBlur: true,
  optionClass: (completion) =>
    `cm-completion-${completion.type || "text"}`,
  addToOptions: [...]
})
```

Putting placeholder completions first prevents `{` from being interpreted by any future generic completion source.

### 4. Extract or Share Dictionary URI Lookup

`PromptEditor.tsx` currently reads dictionary URIs from `document.body`:

```typescript
const affUri = document.body.getAttribute("data-aff-uri") || "./en_US.aff";
const dicUri = document.body.getAttribute("data-dic-uri") || "./en_US.dic";
```

`ScriptConditionEditor` is used in multiple places:

- Prompt-level `PropertiesDrawer`
- Workflow-level `WorkflowPropertiesPanel`
- Global defaults `WorkflowDefaultsSection`
- Script-step mode inside `PromptEditor`

Do not make every parent pass these URIs manually if it creates plumbing noise. Prefer a small webview utility:

```typescript
// src/ui/webview-react/utils/dictionaryUris.ts
export function getDictionaryUris(): { affUri: string; dicUri: string } {
  return {
    affUri: document.body.getAttribute("data-aff-uri") || "./en_US.aff",
    dicUri: document.body.getAttribute("data-dic-uri") || "./en_US.dic",
  };
}
```

Then both `PromptEditor.tsx` and `ScriptConditionEditor.tsx` can use the same helper.

### 5. Replace Retry Prompt Textarea

Modify the retry field in `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`.

Current textarea:

```tsx
<textarea
  id={`${idPrefix}-retry-prompt`}
  value={v.retryPrompt ?? ""}
  onChange={(e) => update({ retryPrompt: e.target.value })}
  placeholder={"Validation failed: {error}\n\nPlease fix the issues."}
  rows={3}
  disabled={disabled}
  className="..."
/>
```

Replacement should preserve:

- Label and `id`
- Disabled state
- Existing form spacing
- Minimum height roughly equivalent to `rows={3}`
- Resize behavior if practical, though CodeMirror will likely use a fixed/min-height editor instead of native `resize-y`

Recommended first-pass UI:

- `min-h-[96px]`
- `max-h-[220px]`
- internal CodeMirror scroll if content grows
- same input border and focus color behavior as other form controls

### 6. Update User-Facing Hint

Replace:

```tsx
Use {"{error}"} placeholder for validation error message
```

With a source-of-truth-aligned hint:

```tsx
Use {"{stderr}"} for stderr, {"{stdout}"} for stdout, or type {"{"} for placeholders.
```

If that is too long for the drawer, use:

```tsx
Type {"{"} for retry placeholders like {"{stderr}"} and {"{stdout}"}.
```

---

## Placeholder Single Source of Truth

The placeholder names are currently hardcoded inside `EndConditionEvaluator.buildRetryPrompt()`. Adding a second hardcoded list in the webview would create drift.

Recommended cleanup:

1. Add a shared constant in `src/types/DashboardConstants.ts`:

```typescript
export const RETRY_PROMPT_PLACEHOLDERS = {
  STDOUT: "stdout",
  STDERR: "stderr",
  EXPECTED_VALUE: "expected",
  ACTUAL_VALUE: "actual",
  EXIT_CODE: "exitCode",
  COMPARE_SOURCE: "compareSource",
} as const;
```

2. Update `EndConditionEvaluator.buildRetryPrompt()` to use that constant:

```typescript
.replace(new RegExp(`{${RETRY_PROMPT_PLACEHOLDERS.STDOUT}}`, "g"), ...)
```

3. Re-export the constant through `src/ui/webview-react/types/messages.ts` or import from `@root/types/DashboardConstants`.

4. Build the CodeMirror completion list from the same constant plus local labels/descriptions.

This follows the repository rule that shared strings across files belong in `DashboardConstants.ts`.

---

## Implementation Steps

1. Add `RETRY_PROMPT_PLACEHOLDERS` to `src/types/DashboardConstants.ts`.

2. Update `src/flightpath/EndConditionEvaluator.ts` to use `RETRY_PROMPT_PLACEHOLDERS` instead of raw placeholder strings. Rename the two output placeholders as part of this change:
   - `{scriptOutput}` → `{stdout}`
   - `{errorOutput}` → `{stderr}`

   Because the project is pre-release, do not add compatibility aliases unless a test fixture or built-in template still depends on the old names. Prefer updating all references to the new names.

3. Add `src/ui/webview-react/utils/dictionaryUris.ts` and update `PromptEditor.tsx` to use it.

4. Extend `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`:
   - add `mode?: "prompt" | "endCondition"`
   - add optional sizing props if needed
   - add local `{` placeholder completions in `endCondition` mode
   - preserve existing prompt-mode behavior exactly

5. Update `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`:
   - import `CodeMirrorEditor`
   - read dictionary URIs via helper
   - replace the retry prompt textarea with `CodeMirrorEditor mode="endCondition"`
   - update the hint text from `{error}` to supported placeholders
   - update the placeholder example to use `{stderr}` rather than `{error}` or `{errorOutput}`

6. Add focused tests:
   - Placeholder constant usage or evaluator interpolation replaces `{stdout}`, `{stderr}`, `{expected}`, `{actual}`, `{exitCode}`, and `{compareSource}`.
   - Legacy `{scriptOutput}`, `{errorOutput}`, and `{error}` are not promised unless explicit compatibility aliases are added.
   - `CodeMirrorEditor` in `endCondition` mode offers placeholder completions when `{` is typed.
   - `CodeMirrorEditor` in default mode does not offer `{` completions.
   - `ScriptConditionEditor` still calls `onChange({ retryPrompt })` when retry prompt content changes.

7. Run:

```bash
npm run typecheck
npm run test:ui
```

Run `npm run compile` as the final integration check because this touches both extension-side and webview-side TypeScript.

---

## Files to Create or Modify

| File                                                                         | Action        | Purpose                                                  |
| ---------------------------------------------------------------------------- | ------------- | -------------------------------------------------------- |
| `src/types/DashboardConstants.ts`                                            | Modify        | Add `RETRY_PROMPT_PLACEHOLDERS` single source of truth   |
| `src/flightpath/EndConditionEvaluator.ts`                                    | Modify        | Use shared placeholder constants in `buildRetryPrompt()` |
| `src/ui/webview-react/utils/dictionaryUris.ts`                               | Create        | Share dictionary URI lookup across editor contexts       |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`                | Modify        | Add `endCondition` mode and `{}` placeholder completions |
| `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`           | Modify        | Replace retry prompt textarea with `CodeMirrorEditor`    |
| `src/ui/webview-react/test/components/editor/CodeMirrorEditor.test.tsx`      | Create/Modify | Cover mode-specific completion behavior                  |
| `src/ui/webview-react/test/components/shared/ScriptConditionEditor.test.tsx` | Create/Modify | Cover retry prompt update behavior                       |
| `src/test/flightpath/EndConditionEvaluator.test.ts`                          | Modify        | Ensure placeholder interpolation remains covered         |

---

## Edge Cases

| Scenario                                    | Expected behavior                                                     |
| ------------------------------------------- | --------------------------------------------------------------------- |
| User types `{`                              | Placeholder completion opens                                          |
| User types `{std`                           | Completion filters to `stdout` and `stderr`                           |
| User accepts `stdout`                       | Editor contains `{stdout}`                                            |
| User types `{unknown}`                      | Text remains valid as literal text; no blocking validation            |
| User types `{` in normal prompt editor      | No retry placeholder completions                                      |
| User types `@`, `#`, or `~` in retry prompt | Existing prompt completions still work                                |
| Retry prompt editor is disabled             | Editor is read-only and sends no edits                                |
| Very long retry prompt                      | Editor scrolls inside its bounded area                                |
| Tooltip near drawer bottom                  | Autocomplete tooltip renders via `document.body` like the main editor |
| Spell checker dictionaries fail to load     | Editor still works, matching current `CodeMirrorEditor` behavior      |

---

## Non-Goals

- Adding new runtime placeholders beyond what `EndConditionEvaluator.buildRetryPrompt()` supports, except the planned pre-release rename from `{scriptOutput}` / `{errorOutput}` to `{stdout}` / `{stderr}`.
- Changing retry execution behavior.
- Validating placeholder names as hard errors.
- Creating a separate retry-prompt-only editor implementation.
- Adding AI inline suggestions to retry prompts.

---

## Future Extensions

- Show hover documentation when the cursor is inside a retry placeholder.
- Add lint diagnostics for unknown `{placeholder}` names as a warning.
- Render placeholder tokens with a subtle decoration.
- Add snippets for common retry prompt templates.
- Add a small “Insert Placeholder” dropdown for mouse-driven editing.
- Support fallback aliases only if the evaluator also supports them, for example mapping `{error}` to `{stderr}` in a future runtime change.
