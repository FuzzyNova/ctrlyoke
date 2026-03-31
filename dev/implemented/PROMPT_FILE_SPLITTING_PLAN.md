# Content-Type-Aware Prompt File Splitting

## Problem

The current splitting strategy treats the assembled prompt as a single blob. The assembly order is `skills → agent → attachments → userPrompt`, so the user prompt is always last. The real problems are:

1. **Wrong line numbers in embedded attachments** — when multiple files are inlined as `<attachment>` blocks inside a single temp file, any harness that reads line N of that file gets the wrong source location. Tools that try to edit based on those line numbers will target the wrong content.
2. **Read-before-edit failures** — most harnesses require reading an actual file before editing it. When a file's content is already embedded in an attachment block, harnesses may skip the read step and reference the embedded content — which has incorrect line numbers and is a snapshot, not the live file.
3. **Large attachment files** — embedding full file contents inflates the temp file and consumes context window unnecessarily.
4. **Copilot auto-summarizer strips the prompt** — VS Code's chat summarizes large attachments before sending to the model. Since the prompt is always at the end of a large context blob, it can get stripped from the summary. The current workaround is splitting context and prompt into separate files — the new plan makes this cleaner.

## Proposed Solution

Three complementary changes:

### Change 1: Direct `@file` references for full-file attachments

For `@path/to/file` and `#file:path` references (full file content), instead of embedding as an `<attachment>` block, emit a direct `@path/to/file` reference. All current harnesses auto-read `@` references.

**What still gets embedded** (no real file path to reference at the right granularity):

- `#selection:path:N-N` — line range excerpt
- `#sym:path:Symbol:line` — symbol context
- `~diff`, `~staged`, `~stash:N`, `~commit:<hash>` — git diffs
- `@path/to/dir/` — directory listing (synthetic)

**Benefits:**

- Line numbers are always correct (harness reads the real file)
- Read-before-edit constraint satisfied trivially
- Attachment file is much smaller (only excerpts and diffs)
- Harness always has the current file state, not an execution-time snapshot

### Change 2: Content-type-aware file splitting

Instead of splitting one combined blob into numbered chunks, split each content category independently into typed files, then construct a structured instruction referencing them. This also cleanly replaces the current chat-specific context/prompt separation hack.

**Target instruction format (CLI harnesses — typed as the prompt):**

```
Following these agent instructions @.flightpath/temp/<ts>-<name>-<step>.agent.1.prompt.md[, @...agent.2.prompt.md],
using these available skills @.flightpath/temp/<ts>-<name>-<step>.skills.prompt.md,
using these file references @src/foo.ts, @src/bar.ts,
and these attachment excerpts @.flightpath/temp/<ts>-<name>-<step>.excerpts.1.prompt.md[, @...excerpts.2.prompt.md],
follow the instructions in @.flightpath/temp/<ts>-<name>-<step>.prompt.md
```

Absent categories are omitted. When only a prompt exists: `Follow instructions in @...prompt.md`.

**New file naming scheme:**

| Category                         | Format                                         | Example                              |
| -------------------------------- | ---------------------------------------------- | ------------------------------------ |
| Agent instructions               | `<ts>-<name>-<step>.agent.<part>.prompt.md`    | `1234-myflow-1.agent.1.prompt.md`    |
| Skills                           | `<ts>-<name>-<step>.skills.prompt.md`          | `1234-myflow-1.skills.prompt.md`     |
| Excerpts (selection/sym/git/dir) | `<ts>-<name>-<step>.excerpts.<part>.prompt.md` | `1234-myflow-1.excerpts.1.prompt.md` |
| Prompt                           | `<ts>-<name>-<step>.prompt.md`                 | `1234-myflow-1.prompt.md`            |

Full-file `@path` references appear inline in the instruction string. Skills and the prompt are almost never large enough to need splitting.

### Change 3: Line numbers in embedded excerpt content

For selection/symbol attachments that remain embedded, prefix each content line with its actual source line number. Format: `    N→content` (matching Claude Code's own output format, already used in `QwenLogParser`).

Git diffs already carry their own line number format. Directory listings don't need line numbers.

## Current Architecture: CopilotChatIntegration

`CopilotChatIntegration` has two distinct paths controlled by `chatUseNativeAttachments`:

**`useNativeAttachments = false` (default)**:

1. Calls `super.buildPromptText()` to get the fully assembled blob (skills → agent → attachments → prompt)
2. Detects whether context was prepended before the raw prompt text
3. If yes: writes context to temp files using the smaller chat split config (`maxTokensPerFile: 8000, maxLinesPerFile: 600`), and writes the prompt to its own dedicated file — this prevents Copilot's auto-summarizer from stripping the prompt
4. Attaches all temp files to chat via `workbench.action.chat.attachFile`
5. Returns `"Follow instructions in ..."` as the typed chat message

**`useNativeAttachments = true` (opt-in)**:

1. Uses `NativeAttachmentHandler.processAttachments()` to attach files/selections via VS Code native commands
2. Agent is handled by `openAgentSpecificChat()` which opens the agent-specific chat window
3. Returns the raw prompt text as the typed chat message
4. **Known bug**: Skills are not attached — there is no VS Code native skill API, so skill instructions are dropped entirely in this mode

## How Chat Integrates with the New Plan

### `useNativeAttachments = false`

This path can fully adopt the categorized file splitting. The typed message format and the file structure are identical to CLI harnesses — the only difference is that files are attached via `workbench.action.chat.attachFile` rather than referenced as `@path` in a CLI prompt string.

For direct file references (`@src/foo.ts`), instead of emitting them in the typed string, attach the actual workspace file via `attachFile`. This is better than the current path which would have embedded those files in a blob.

The current context/prompt split hack is replaced cleanly: agent instructions, skills, excerpts, and the prompt are each in their own typed file from the start.

The chat-specific split config (`maxTokensPerFile: 8000, maxLinesPerFile: 600`) still applies to all categorized files — this limit exists because VS Code summarizes large chat attachments.

### `useNativeAttachments = true`

The skills bug can be fixed by writing a skills `.prompt.md` file and attaching it via `attachFile`, which is the same mechanism used for everything else in this mode. This is the right approach because there is no native skill API — a prompt file is the best available option.

The direct file references and selection/excerpt handling can also be improved using the new `ContextExpander.expandContextSplit()` output:

- Full-file refs → attach actual workspace files via `attachFile` (already what `NativeAttachmentHandler` does)
- Selection/sym/git excerpts → write to a `.excerpts.prompt.md` file and attach via `attachFile`

## Architecture Changes

### `ContextExpander` — add `expandContextSplit()`

Add alongside the existing `expandContext()` (keep existing for backward compat):

```typescript
interface SplitContext {
  directFileRefs: string[];    // absolute paths for full-file @path refs
  excerptBlocks: string;       // embedded XML for selection/sym/git/dir content
}
expandContextSplit(promptText: string): Promise<SplitContext>
```

### `HarnessIntegration` — add `buildPromptSections()`

Add alongside existing `buildPromptText()` (keep for backward compat):

```typescript
interface PromptSections {
  skillContent: string | null;
  agentContent: string | null;
  directFileRefs: string[];      // full-file @paths (no embedding)
  excerptContent: string | null; // selection/sym/git/dir attachment blocks
  userPromptText: string;
}
buildPromptSections(prompt, resolvedAgent?, resolvedSkills?): Promise<PromptSections>
```

### `TempFileManager` — add categorized file creation

```typescript
createCategoryFile(content, category: 'agent' | 'skills' | 'excerpts' | 'prompt', basename, stepNumber?, partNumber?): Promise<string>
createCategorySplitFiles(chunks, category: 'agent' | 'excerpts', basename, stepNumber?): Promise<string[]>
```

`cleanupOrphanedFiles` already matches `*.prompt.md` — no changes needed.

### `CliIntegration` — categorized prompt file method

Add `createCategorizedPromptFiles(sections, context?)` and `formatCategorizedReferences(...)` alongside the existing path. Opt-in per harness via `useCategorizedFileSplitting(): boolean` defaulting to `false`.

### `CopilotChatIntegration` — replace `buildTempFilePrompt` and `wrapInTempFilePrompt`

Replace the current context/prompt split logic with the categorized approach. Both `useNativeAttachments` paths call `buildPromptSections()` first, then diverge only on how files are delivered:

- `false`: create categorized temp files → attach all via `attachFile` → return structured instruction string as typed message
- `true`: attach actual workspace files for direct refs → write excerpts/skills to temp files → attach via `attachFile` → return raw prompt as typed message

### `AttachmentBuilders` — add line number prefixes to excerpts

For `buildFileAttachment` (selection/symbol): prefix each content line with its actual 1-based source line number.

## Files to Change

| File                                                    | Change                                                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/PromptFileSplitter.ts`                       | Default `maxTokensPerFile`: 15000 → 10000 ✅ done                                                                          |
| `src/utils/ContextExpander.ts`                          | Add `expandContextSplit()`                                                                                                 |
| `src/utils/AttachmentBuilders.ts`                       | Add line numbers to selection/symbol content                                                                               |
| `src/utils/TempFileManager.ts`                          | Add `createCategoryFile` / `createCategorySplitFiles`                                                                      |
| `src/flightpath/HarnessIntegration.ts`                  | Add `buildPromptSections()`, keep `buildPromptText()`                                                                      |
| `src/flightpath/harness/CliIntegration.ts`              | Add `createCategorizedPromptFiles`, `formatCategorizedReferences`, opt-in flag                                             |
| `src/flightpath/harness/chat/CopilotChatIntegration.ts` | Replace `buildTempFilePrompt`/`wrapInTempFilePrompt` with categorized approach; fix skills bug for native attachments mode |
| `src/test/promptFileSplitter.test.ts`                   | Update token limit tests                                                                                                   |
| `src/test/contextExpander.test.ts`                      | Add tests for `expandContextSplit()`                                                                                       |

## Implementation Notes

### Quoting paths with spaces in direct file references

When emitting `@path/to/file` references for direct file attachments, paths containing spaces must be quoted: `@"path/with spaces/file.ts"`. Previously this wasn't an issue because all temp files land in `.flightpath/temp/` which never has spaces. Direct file references can point anywhere in the workspace — including directories like `src/my module/foo.ts`.

The quoting logic already exists in `src/completions/CompletionHelpers.ts:358`:

```typescript
const insertPath = relativePath.includes(" ")
  ? `"${relativePath}"`
  : relativePath;
```

The `formatCategorizedReferences` builder must apply the same logic when constructing the inline `@path` strings for `directFileRefs`. The `formatFileReference()` provider override should also receive the raw path and apply quoting before returning.

### `@path` references in `userPromptText`

Do NOT strip `@path` tokens from `userPromptText`. They provide critical prompt context — "look at @file.ts and tell me how it relates to @file2.ts" loses its meaning entirely if the references are removed. No harness recursively loads `@` refs from files referenced inside a prompt file (Claude Code only follows `@` references in top-level `CLAUDE.md` files, not from files loaded via `@`-reference in a prompt). There is no double-loading problem. The `@path` tokens in the user's prompt text are left exactly as written.

### Typed message format for chat `useNativeAttachments = false`

Use the same structured instruction string as CLI harnesses — do not simplify to "follow the attached files." With a realistic large workflow (agent split 3 ways + skills in 2 files + 10 direct file attachments + 3 excerpt files + 2 prompt files), a vague instruction gives the model no navigation context. The explicit structured format tells the model what each attached file contains and where to find the actual task. The `userPromptText` (inside the prompt file) also retains all original `@path` tokens, so context is preserved at both levels.

## Open Questions

1. **Slash command prefix with categorized format**: `/handoff Following these agent instructions @... follow the instructions in @prompt.md` — the prefix prepend logic in `CliIntegration` prepends to the whole string and should still work.

2. **Harnesses that don't auto-read `@` refs in headless mode**: All current harnesses read `@` references in the prompt string. Worth a quick verification for Qwen and Codex in headless mode specifically.

3. **Chat summarizer threshold**: The current chat split config is `maxTokensPerFile: 8000`. With categorized splitting, each file is a single semantic unit (agent instructions, skills, excerpts, prompt). Agent files are the most likely to hit the limit and need splitting. The 8000 threshold applies per-category file in the chat path.
