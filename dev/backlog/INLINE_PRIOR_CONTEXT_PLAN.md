# Inline Prior Context Plan

## Background

`priorContext` is a workflow/prompt execution property (keyword or number array) that controls
injection of prior prompt outputs as XML into the prompt before sending. It does its job well,
especially for the "inject into every prompt at the workflow level" use case — setting
`priorContext: previous` at the workflow header is faster than adding `$previous` to every
step manually.

This plan adds `$`-triggered inline syntax as a **complement** to the existing property, not a
replacement. Inline references are better when you want to reference a specific prior output
explicitly within the prompt body ("take what Claude said in `$previous` and implement it
below"). The property is better when you want silent injection across all steps without
touching every prompt.

Both mechanisms can be active at the same time. The implementation deduplicates their output
so the same step's content is never attached twice.

---

## New `$` Syntax

| Syntax            | Equivalent property               | Description                                      |
| ----------------- | --------------------------------- | ------------------------------------------------ |
| `$previous`       | `priorContext: previous`          | Output of the immediately preceding queue prompt |
| `$all`            | `priorContext: all`               | Outputs of all prior queue prompts               |
| `$finalStep`      | `priorContext: finalStepPrevious` | Output of the previous finalStep loop execution  |
| `$allFinalStep`   | `priorContext: finalStepAll`      | Outputs of all finalStep loop executions         |
| `$prompt:N`       | `priorContext: [N]`               | Output of a specific prompt by 1-based number    |
| `$prompt:N,M,A-B` | `priorContext: [N,M,A,…,B]`       | Outputs of specific prompts via range notation   |

Range notation uses the same `1,2,4-10` format already supported in `PriorContextSelect`. Any
combination of comma-separated numbers and `A-B` ranges is valid.

**Example — inline explicit reference:**

```
Hey Copilot, take a look at what Claude told me to do in $previous — can you implement it?
```

**Example — mixed with property (deduplicated):**

```yaml
# workflow level: priorContext: previous  →  always inject previous output
steps:
  - name: analyze
    prompt: Analyze the architecture.
  - name: implement
    # $previous will be deduplicated with the workflow-level "previous" injection
    prompt: |
      $previous

      Now also incorporate the patterns from $prompt:1.
      Implement all the suggestions.
```

### Stretch goal: cross-workflow reference

`$workflow-xyz:prompt:1` — reference output from a named workflow's step 1. Deferred until
`OutputHistoryManager` exposes a lookup API by workflow name and step index. The parser will
ignore unrecognized `$xxx` tokens, so old files won't break when support is added.

---

## Deduplication

When both `priorContext` property and inline `$` refs are active for the same prompt, the
resolved context items may overlap (e.g., the property says "previous" AND the prompt contains
`$previous`). All sources are gathered together first and then deduplicated by `(index, type)`
pair before assembling the XML block.

All context — from the property AND from inline refs — is merged into the **single**
`.context.prompt.md` temp file (or the inline `<priorContext>` XML block). There is never more
than one context block attached to a prompt. This is both simpler and cleaner for the AI.

### Resolution order

1. Gather items from `resolvedProperties.priorContext` (existing logic, unchanged)
2. Gather items from `parseInlinePriorContextRefs(promptText)` (new)
3. Merge lists; deduplicate by `(index, type)` — keep the first occurrence, preserve
   source order (property items first, then inline items that add new indices)
4. Assemble XML once

---

## Phase 1: Add `$` parser to `FileReferenceParser.ts`

Add a new exported function `parseInlinePriorContextRefs(text: string)` to
`src/utils/FileReferenceParser.ts`. The expansion stays in `CliPromptPreparer` /
`HarnessIntegration` because `$` refs are runtime-dynamic (they depend on prompt response
text, not static file contents).

### Return type

```typescript
export type InlinePriorContextRef =
  | { kind: "previous" }
  | { kind: "all" }
  | { kind: "finalStep" }
  | { kind: "allFinalStep" }
  | { kind: "prompt"; indices: number[] }; // 1-based, sorted, deduped

export interface InlinePriorContextMatch {
  ref: InlinePriorContextRef;
  /** The full matched token, e.g. "$previous" or "$prompt:1,3-5". */
  token: string;
}
```

### Parser logic

```typescript
export function parseInlinePriorContextRefs(
  text: string
): InlinePriorContextMatch[] {
  // Regex: $ followed by one of the known keywords or "prompt:range"
  // Terminated by whitespace, end-of-string, or non-token char
}
```

Recognized tokens: `$previous`, `$all`, `$finalStep`, `$allFinalStep`, `$prompt:RANGE`.
Unrecognized `$xxx` tokens are silently ignored (pass through to the AI unchanged).
Invalid `$prompt:` ranges (e.g. `$prompt:abc`) are logged as a warning and skipped.

### Range notation utility

`parseRangeNotation()` currently lives inside `PriorContextSelect.tsx`. Extract it to
`src/utils/RangeNotationParser.ts` as a standalone export that both `FileReferenceParser` and
`PriorContextSelect` import.

```typescript
// src/utils/RangeNotationParser.ts
/**
 * Parse range notation like "1,2,4-10" into a sorted, deduplicated number[].
 * Returns null if the input is invalid or empty.
 */
export function parseRangeNotation(text: string): number[] | null { ... }
```

---

## Phase 2: Runtime expansion — merge inline refs into existing context gathering

### `HarnessIntegration.gatherPriorContextItems()` / `buildPriorContextXml()`

These methods remain in the base class. Their signatures do not change. The only change is in
how they're called: after gathering items from the `priorContext` property, also gather items
from inline refs and merge with deduplication before building the XML.

Add a new protected helper:

```typescript
protected gatherAndMergeContextItems(
  propertyContext: PriorContext | undefined,
  inlineRefs: InlinePriorContextRef[],
  allsteps: WorkflowStep[],
  promptIndex: number,
  finalStepResponseTexts: string[]
): PriorContextItem[] {
  const propertyItems =
    propertyContext && propertyContext !== "none"
      ? this.gatherPriorContextItems(propertyContext, allPrompts, promptIndex, finalStepResponseTexts)
      : [];

  const inlineItems = inlineRefs.flatMap((ref) =>
    this.gatherPriorContextItems(refToPriorContext(ref), allPrompts, promptIndex, finalStepResponseTexts)
  );

  // Deduplicate by (index, type) — property items take priority
  return deduplicatePriorContextItems([...propertyItems, ...inlineItems]);
}
```

Where `refToPriorContext(ref: InlinePriorContextRef): PriorContext` maps each ref to the
equivalent `PriorContext` value (e.g. `{ kind: "previous" } → "previous"`).

Add a private utility:

```typescript
function deduplicatePriorContextItems(
  items: PriorContextItem[]
): PriorContextItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type ?? "queue"}:${item.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

### `CliPromptPreparerDeps` interface

Add the new dep:

```typescript
gatherAndMergeContextItems: (
  propertyContext: PriorContext | undefined,
  inlineRefs: InlinePriorContextRef[],
  allsteps: PromptItem[],
  promptIndex: number,
  finalStepResponseTexts: string[]
) => PriorContextItem[];
```

The existing `buildPriorContextXml` dep (called after gathering) is unchanged.

### `CliPromptPreparer.preparePrompt()`

Replace the existing `resolvedPriorContext` block with:

```typescript
const resolvedPriorContext = resolvedProperties?.priorContext;
const inlineRefs = parseInlinePriorContextRefs(sections.userPromptText);
const hasPriorContext =
  (resolvedPriorContext !== undefined && resolvedPriorContext !== "none") ||
  inlineRefs.length > 0;

// ...

const contextContent = hasPriorContext
  ? (() => {
      const items = this.deps.gatherAndMergeContextItems(
        resolvedPriorContext,
        inlineRefs,
        allPrompts,
        promptIndex,
        finalStepResponseTexts ?? []
      );
      return items.length > 0
        ? this.deps.buildPriorContextXmlFromItems(items)
        : undefined;
    })()
  : undefined;
```

Add a new dep `buildPriorContextXmlFromItems(items: PriorContextItem[]): string` that takes
pre-gathered items (replacing the existing full-pipeline dep). The `buildPriorContextXml` base
class method is refactored to accept items directly (the gathering step is separated out).

### `CopilotChatIntegration`

Locate the `resolvedProperties.priorContext` reference (around line 1192). After resolving the
property value, also call `parseInlinePriorContextRefs(promptText)` and merge via
`gatherAndMergeContextItems`. The resulting items feed the same XML builder. The
`.context.prompt.md` temp file mechanism is unchanged — only its input changes.

---

## Phase 3: Completions

### `CompletionHelpers.ts`

Add `getPriorContextCompletions(filterText: string): PlainCompletionItem[]`:

```typescript
export function getPriorContextCompletions(
  filterText: string
): PlainCompletionItem[] {
  const keywords = [
    { label: "previous", detail: "Output of the previous prompt" },
    { label: "all", detail: "Outputs of all prior prompts" },
    { label: "finalStep", detail: "Previous finalStep output" },
    { label: "allFinalStep", detail: "All finalStep outputs" },
    { label: "prompt:", detail: "Specific prompts — e.g. $prompt:1,3-5" },
  ];
  return keywords
    .filter((k) => k.label.startsWith(filterText))
    .map((k) => ({
      label: k.label,
      kind: vscode.CompletionItemKind.Keyword,
      insertText: k.label,
      detail: k.detail,
    }));
}
```

Synchronous — no file I/O.

### `PromptCompletionProvider.ts`

1. Expand `TriggerChar` to `"@" | "#" | "~" | "$"`.
2. Add `lastDollarIndex` to the `lastIndexOf` block; include in `maxIndex`.
3. Add `getDollarCompletions(afterTrigger: string)` calling `getPriorContextCompletions`.
4. Character class validation: bail if `afterTrigger` contains chars outside
   `[a-zA-Z0-9:,\-]`.
5. Route `$` in `provideCompletionItems`.

### `extension.ts`

Add `"$"` as a fourth trigger when registering `PromptCompletionProvider`.

### `CodeMirrorEditor.tsx`

```typescript
const lastDollarIndex = textBefore.lastIndexOf("$");

const maxIndex = Math.max(
  lastAtIndex,
  lastHashIndex,
  lastTildeIndex,
  lastDollarIndex
);

// ...

if (maxIndex === lastDollarIndex) {
  trigger = "$";
  afterTrigger = textBefore.slice(lastDollarIndex + 1);
}

// Character class validation for $
if (trigger === "$" && !/^[a-zA-Z0-9:,\-]*$/.test(afterTrigger)) return null;
```

The `fromOffset = 1` logic already handles non-`path` triggers, so no special casing needed.

### `WebviewMessageRouter.ts`

Add the `$` branch in `getCompletionItems()`:

```typescript
} else if (trigger === "$") {
  return getPriorContextCompletions(prefix.substring(1));
}
```

---

## Open Questions / Notes

**No removal of `priorContext`.** The existing property, UI, and schema remain exactly as-is.
`PriorContextSelect`, `ContextQuickPicker`, and the Context tab are all untouched by this plan.
The Additional Instructions plan reuses the Context tab independently.

**`$workflow-xyz:prompt:N` cross-workflow syntax.** Deferred. The parser ignores unrecognized
`$xxx` tokens today, so files won't break when support is added later.

**Tests to add:**

- `parseInlinePriorContextRefs()` — all keyword forms, range notation, unknown tokens ignored,
  invalid range logged
- `parseRangeNotation()` — existing range notation tests from `PriorContextSelect` (if any)
  migrated to the new utility
- `gatherAndMergeContextItems()` — overlap deduplication, all-from-property-only,
  all-from-refs-only, mixed

---

## File Change Summary

| File                                                            | Change                                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/RangeNotationParser.ts`                              | New — extract `parseRangeNotation()` from `PriorContextSelect.tsx`                                                                                        |
| `src/utils/FileReferenceParser.ts`                              | Add `parseInlinePriorContextRefs()`, `InlinePriorContextRef`, `InlinePriorContextMatch`                                                                   |
| `src/ui/webview-react/components/shared/PriorContextSelect.tsx` | Import `parseRangeNotation` from new utility instead of defining it locally                                                                               |
| `src/flightpath/HarnessIntegration.ts`                          | Add `gatherAndMergeContextItems()`, `deduplicatePriorContextItems()`, `refToPriorContext()`; refactor `buildPriorContextXml` to accept pre-gathered items |
| `src/flightpath/harness/shared/CliPromptPreparer.ts`            | Replace `resolvedPriorContext`-only block with merged property+inline logic; update `CliPromptPreparerDeps`                                               |
| `src/flightpath/harness/chat/CopilotChatIntegration.ts`         | Add inline ref parsing alongside property resolution                                                                                                      |
| `src/completions/CompletionHelpers.ts`                          | Add `getPriorContextCompletions()`                                                                                                                        |
| `src/completions/PromptCompletionProvider.ts`                   | Add `$` to `TriggerChar`; add `getDollarCompletions()`; extend `lastIndexOf` block                                                                        |
| `src/extension.ts`                                              | Add `"$"` to completion trigger characters                                                                                                                |
| `src/ui/WebviewMessageRouter.ts`                                | Add `$` branch to `getCompletionItems()`                                                                                                                  |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`   | Add `lastDollarIndex`; add `$` character class validation                                                                                                 |
