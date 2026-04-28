# Backtick Context Suppression Plan

## Overview

Teach `ContextExpander` to skip expanding `@path`, `#sym:`, `#selection:`, `#file:`, and `~git` references that appear inside triple-backtick fenced blocks. References outside fenced blocks expand normally.

This gives users inline, per-block control over context expansion without needing any schema property or workflow-level configuration. Wrapping an entire prompt in triple backticks is the degenerate case that fully suppresses all expansion — equivalent in effect to `rawPromptMode: true` but without requiring YAML changes.

## Motivation

Users frequently embed literal output, log data, or existing FlightPath instruction strings in their prompts:

```
Referencing @src/utils/ContextExpander.ts, analyze why this prior session output is wrong:
```

using these attachment excerpts @.flightpath/temp/abc-excerpts.md,
follow the instructions in @.flightpath/temp/abc-prompt.md

```
Fix the issue.
```

Without suppression, FlightPath would attempt to expand all four `@` references, corrupting the debug prompt. With suppression, only the first reference expands; the fenced block is passed through verbatim.

## Scope of Suppression

Only **triple-backtick fenced blocks** suppress expansion. Single-backtick inline code does not:

| Syntax                        | Suppresses expansion?                                    |
| ----------------------------- | -------------------------------------------------------- |
| ` ```\n@path/to/file\n``` `   | Yes                                                      |
| ` ```typescript\n@path\n``` ` | Yes (language specifier ignored)                         |
| `` `@path/to/file` ``         | No — single backticks are inline code, not fenced blocks |

This matches standard Markdown semantics: fenced blocks are multi-line literal content; inline code is a short span.

## Implementation

### Location: `src/utils/ContextExpander.ts`

Add a private `maskBacktickBlocks()` helper and call it at the top of both `expandContext()` and `expandContextSplit()` before any reference parsing.

**`maskBacktickBlocks(text: string): string`**

Replaces the trigger characters (`@`, `#`, `~`) inside triple-backtick regions with a null byte (`\x00`) so `parseAllFileReferences` and `parseGitChangeReferences` never see them. The original `text` is still sent to the harness unchanged — masking applies only to the reference-detection pass.

````typescript
private maskBacktickBlocks(text: string): string {
  // Replace @, #, ~ inside ``` fenced blocks so the reference parsers
  // never see them. Uses non-greedy match to handle multiple blocks.
  // Language specifiers (```typescript) are handled naturally since the
  // regex matches from ``` to the next ```.
  return text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/[@#~]/g, "\x00")
  );
}
````

**Wire into `expandContext()`:**

```typescript
async expandContext(promptText: string): Promise<string> {
  const masked = this.maskBacktickBlocks(promptText);
  let fileReferences = parseAllFileReferences(masked);
  const gitRefs = parseGitChangeReferences(masked);
  // ... rest unchanged, promptText still used for the returned value
}
```

**Wire into `expandContextSplit()`:**

```typescript
async expandContextSplit(promptText: string): Promise<SplitContext> {
  const masked = this.maskBacktickBlocks(promptText);
  const fileReferences = parseAllFileReferences(masked);
  const gitRefs = parseGitChangeReferences(masked);
  // ... rest unchanged
}
```

The masking is intentionally lossy (positions shift by replacing multi-char tokens with `\x00`). This is fine because we only use the parsed references' paths/line numbers, not their character offsets in the original string.

## Edge Cases

**Multiple fenced blocks:** The `g` flag handles all blocks in one pass.

**Unclosed fenced blocks:** If a prompt has an unclosed ` ``` `, the non-greedy `[\s\S]*?` will not match (no closing ` ``` `), so nothing is masked. References after an unclosed fence expand normally. This is consistent with how Markdown renderers handle malformed fences.

**Fenced blocks containing no references:** No-op — masking replaces nothing, no performance impact.

**References immediately adjacent to fences** (e.g. `@path``` block ```@path`): Only the content between the backtick pairs is masked. References outside the block expand normally.

**Inline backticks containing `@`** (e.g. `` `@path` ``): Not suppressed. Single backticks are not matched by the triple-backtick pattern. This is the correct behavior — inline code is typically a short span within prose, not raw data to pass through.

## Files Changed

| File                           | Change                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `src/utils/ContextExpander.ts` | Add `maskBacktickBlocks()` private method; call at top of `expandContext()` and `expandContextSplit()` |

No schema, type, parser, or resolver changes required.

## Testing

- **Unit test**: Prompt with `@path` inside a fenced block → no file reference parsed, no temp file created.
- **Unit test**: Prompt with `@path` both inside and outside a fenced block → only the outside reference expanded.
- **Unit test**: Prompt with multiple fenced blocks, references in each → none expanded.
- **Unit test**: Prompt with `#sym:`, `~diff`, `#selection:` inside fenced block → none expanded.
- **Unit test**: Unclosed fence → references after it expand normally.
- **Unit test**: Single-backtick inline code with `@path` → reference IS expanded (not suppressed).
- **Manual test**: Wrap entire prompt in ` ``` ` — equivalent to `rawPromptMode: true`, prompt sent verbatim with no categorized temp files needed (ContextExpander returns empty refs, so `CliPromptPreparer` takes the simple/single-file path).

## Relationship to `rawPromptMode`

These are independent features. `rawPromptMode` bypasses `buildPromptSections()` entirely (no agent/skills/priorContext injection, no categorized file structure). Backtick suppression only affects what `ContextExpander` expands — agent/skills/priorContext still run normally.

When both are used together, `rawPromptMode` takes effect first (bypasses the whole pipeline), so backtick suppression is irrelevant for that prompt. No conflict.
