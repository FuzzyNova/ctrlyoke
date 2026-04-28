# Raw Prompt Mode Plan

## Overview

Add a new `rawPromptMode` execution property that bypasses FlightPath's entire context expansion and categorized temp file pipeline. When enabled, the prompt text is sent verbatim to the harness — no `@path`/`#sym:`/`#selection:` expansion, no categorized temp files, no agent/skills injection, no prior context wrapping. The prompt is sent inline (if it qualifies as a simple prompt) or via a single bare temp file with no instruction wrapper.

## Relationship to Backtick Context Suppression

A companion feature (see `BACKTICK_CONTEXT_SUPPRESSION_PLAN.md`) adds selective suppression of context expansion inside triple-backtick blocks directly in `ContextExpander`. These are **independent, complementary features**:

|                                   | Backtick suppression                                   | `rawPromptMode`                                                    |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| **Scope**                         | Selective — suppresses refs inside ` ``` ` blocks only | Full bypass — suppresses all expansion + agent/skills/priorContext |
| **Granularity**                   | Per-block within a prompt                              | Per-step or per-workflow                                           |
| **Requires editing prompt text**  | Yes                                                    | No — set at workflow YAML level                                    |
| **Useful for file-based prompts** | Only if you edit the `.prompt.md` file                 | Yes — apply without touching the file                              |
| **Implementation location**       | `ContextExpander`                                      | `CliPromptPreparer`                                                |

> **Why rawPromptMode does NOT implement via backtick-wrapping:** Wrapping the prompt in ` ``` ` and passing to `ContextExpander` would send literal backtick fences to the AI. `rawPromptMode` bypasses `buildPromptSections()` entirely instead.

Implement backtick suppression first — it is the more broadly useful primitive and covers most inline use cases. `rawPromptMode` addresses the remaining cases: workflow-level configuration, file-based prompts, and full pipeline bypass for skeptical users.

## Motivation

Three distinct use cases drive this feature:

1. **Bypass context building**: Users who manage their own context references and don't want FlightPath touching the prompt text. (Note: for inline prompts, backtick wrapping the whole prompt is equivalent and requires no schema config.)
2. **FlightPath self-debugging**: When debugging a FlightPath session (e.g. "debug this output I got from prompt A"), the debug prompt itself contains raw FlightPath instruction strings (`using these attachment excerpts @...`). Without raw mode, FlightPath would attempt to re-expand those references, corrupting the debug prompt.
3. **Trust skeptics**: Some users distrust harness wrappers that "modify the prompt." Raw mode gives them a verifiable pass-through while still using FlightPath for automation.

## Schema Changes

### `schemas/prompt-schema.json`

Add `rawPromptMode` to the `executionProperties` definition's `properties` block:

```json
"rawPromptMode": {
  "type": "boolean",
  "description": "When true, bypass all FlightPath context expansion (no @path/@sym/#selection expansion, no agent/skills injection, no prior context wrapping, no categorized temp files). The prompt text is sent verbatim to the harness — inline if short and safe, otherwise via a single raw temp file. Incompatible with agent, skills, mcpServers (flightpath), and priorContext; those fields are ignored when rawPromptMode is true."
}
```

## Type System Changes

### `src/types/FlightPathTypes.ts`

Add to `ExecutionProperties` interface:

```typescript
/**
 * When true, bypass all context expansion and temp file categorization.
 * The prompt text is passed verbatim to the harness.
 * Incompatible with agent, skills, priorContext (ignored when set).
 */
rawPromptMode?: boolean;
```

### `src/utils/PropertyResolver.ts`

**Add to `ResolvedProperties` interface:**

```typescript
rawPromptMode: boolean;
```

**Add resolver method** (after `resolveHooks`):

```typescript
private static resolveRawPromptMode(
  prompt: PromptStep,
  workflow: PromptFile
): boolean {
  if (prompt.rawPromptMode !== undefined) return prompt.rawPromptMode;
  if (workflow.rawPromptMode !== undefined) return workflow.rawPromptMode;
  return false; // default: context expansion enabled
}
```

**Wire into `resolve()`:** Add `rawPromptMode: this.resolveRawPromptMode(prompt, workflow)` to the returned object.

> No VS Code settings fallback is needed. This is an intentional, workflow-specific opt-in — a global default would be surprising and would silently break workflows that rely on context expansion.

## Parser Changes

### `src/flightpath/PromptFileParser.ts`

Add `rawPromptMode` copying in both:

- `buildPromptStep()` (prompt-level): `if (source.rawPromptMode !== undefined) step.rawPromptMode = source.rawPromptMode;`
- `copyWorkflowLevelProperties()` (workflow-level): `if (parsed.rawPromptMode !== undefined) file.rawPromptMode = parsed.rawPromptMode;`

Follow the exact pattern used by `resumeSession`.

## Core Logic Changes

### `src/flightpath/harness/shared/CliPromptPreparer.ts`

This is the primary bypass point. The goal is to short-circuit `preparePrompt()` before it calls `buildPromptSections()` (which triggers context expansion, agent/skills expansion, and temp file creation).

**At the top of `preparePrompt()`**, after basic validation but before any expansion:

```typescript
if (resolvedProperties?.rawPromptMode) {
  return this.prepareRawPrompt(promptText);
}
```

**Add `prepareRawPrompt()` method:**

```typescript
private async prepareRawPrompt(promptText: string): Promise<PromptFileResult> {
  // Use the same simple-prompt path if the text qualifies
  if (this.deps.isSimplePrompt(promptText)) {
    return { promptWithInstruction: promptText, tempFilePaths: [] };
  }

  // For longer or unsafe text, write a single bare temp file with no instruction wrapper
  const filePath = await this.deps.tempFileManager.createCategoryFile(
    promptText,
    TEMP_FILE_CATEGORIES.PROMPT,
    undefined,
    this.stepNumber
  );
  return {
    promptWithInstruction: `@${path.basename(filePath)}`,
    tempFilePaths: [filePath],
  };
}
```

Key properties of `prepareRawPrompt()`:

- **No `ContextExpander.expandContextSplit()` call** — `@path` and `#sym:` references in the text are passed through unchanged.
- **No agent/skills sections** — even if `resolvedProperties.agent` is set, it is ignored.
- **No prior context wrapping** — `priorContext` is ignored.
- **Single temp file, no instruction wrapper** — the file reference uses the harness's natural `@file` syntax with no preamble text.
- **No excerpt/categorized file splitting** — one file, raw content.

### `src/flightpath/HarnessIntegration.ts`

No changes required to the base class. The bypass happens upstream in `CliPromptPreparer` before `buildPromptSections()` is called. `isSimplePrompt()` is already accessible via the `deps` injection on `CliPromptPreparer`.

### `src/flightpath/harness/chat/CopilotChatIntegration.ts`

If `CopilotChatIntegration` has its own prompt preparation path that calls `buildPromptSections()` or similar, the same `rawPromptMode` guard should be added there. Audit this file during implementation.

## Warnings for Ignored Properties

There are two categories of "ignored" things in raw mode and they should be handled differently:

### Property-level ignores → visible warning

`agent`, `skills`, and `priorContext` are explicit workflow-level settings that the user configured. Silently dropping them would be confusing. Emit a user-visible warning (output channel, not just debug log) for each one that was set:

```typescript
const ignored: string[] = [];
if (resolvedProperties.agent) ignored.push("agent");
if (resolvedProperties.skills?.length) ignored.push("skills");
if (resolvedProperties.priorContext) ignored.push("priorContext");
if (ignored.length > 0) {
  Log.warn(
    `rawPromptMode: the following properties were ignored because rawPromptMode is enabled: ${ignored.join(", ")}. ` +
      `Disable rawPromptMode or remove these properties to re-enable them.`
  );
}
```

`Log.warn` should surface in the FlightPath output channel so the user sees it during execution — verify this is the case during implementation, and if not, use the appropriate output-visible call.

### Text-level references → no warning

Context references in the prompt text itself (`@path/to/file`, `#sym:path:symbol`, `#selection:path:N-N`) are intentionally left unexpanded in raw mode — that's the point. Do **not** scan the prompt text for these patterns and warn about them. A user writing `@src/foo.ts` in a rawPromptMode prompt knows it will be passed through verbatim; a warning here would be actively wrong.

## Compatibility with `mcpServers: ["flightpath"]`

`rawPromptMode` is **fully compatible** with `mcpServers: ["flightpath"]`. The FlightPath MCP server is attached via a generated config file passed as a CLI argument — it does not inject any instructions into the prompt text. The AI discovers the MCP server's tools and their built-in descriptions through the MCP protocol itself. Raw mode skips the prompt instruction wrapper but leaves the MCP config attachment untouched.

## Files Changed (Summary)

| File                                                    | Change                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `schemas/prompt-schema.json`                            | Add `rawPromptMode` boolean to `executionProperties` definition                  |
| `src/types/FlightPathTypes.ts`                          | Add `rawPromptMode?: boolean` to `ExecutionProperties`                           |
| `src/utils/PropertyResolver.ts`                         | Add to `ResolvedProperties`, add `resolveRawPromptMode()`, wire into `resolve()` |
| `src/flightpath/PromptFileParser.ts`                    | Copy `rawPromptMode` in `buildPromptStep()` and `copyWorkflowLevelProperties()`  |
| `src/flightpath/harness/shared/CliPromptPreparer.ts`    | Add early-return guard + `prepareRawPrompt()` method                             |
| `src/flightpath/harness/chat/CopilotChatIntegration.ts` | Audit + add guard if it has its own prep path                                    |
| `schemas/prompt-schema.yaml`                            | Regenerated via `npm run generate-schema` (do not hand-edit)                     |

## Windows / node-pty Character Limit Analysis

### Why the 32767-char limit still applies

FlightPath no longer uses VS Code's built-in terminal (`vscode.window.createTerminal` + `terminal.sendText()`). Interactive mode now spawns the AI CLI via node-pty (`PtyProcessManager.spawnPty()`). On Windows, `CliTransportCoordinator.startInteractiveProcess()` builds shell args as:

```typescript
["-NoProfile", "-Command", String(tuiCommand)];
```

node-pty calls `CreateProcess` directly (no shell wrapper), passing the entire assembled command line. Windows `CreateProcess` has a hard 32767-character limit on `lpCommandLine`. This applies regardless of whether the shell is PowerShell 5.1 or pwsh 7+.

### Two execution paths, different limits

| Path                      | How prompt reaches the AI                                                   | Effective limit                          |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| **Spawn (fresh session)** | Embedded in `tuiCommand` → `CreateProcess` arg                              | 32767 chars (Windows OS limit)           |
| **Inject mode (resume)**  | Written to PTY via `ptyManager.writeToSession()` — no command line involved | Effectively unlimited (PTY input stream) |

In inject mode, the prepared `session.promptArgument` is typed into the running TUI via PTY write, so there is no command line length constraint at all.

### Why we can't exploit inject-mode's unlimited capacity for rawPromptMode

The prompt is built (temp files written or inline text chosen) **before** the executor decides whether inject mode is available. At build time, we don't know whether the next execution will spawn fresh or inject into an existing session. We must build for the worst case: a fresh spawn.

### rawPromptMode behavior for oversized prompts

| Prompt length               | Safe chars? | rawPromptMode action                                                                                                    |
| --------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| ≤ 300 chars                 | Yes         | Pass inline (same as `isSimplePrompt`)                                                                                  |
| ≤ 300 chars                 | No          | Fall back to single bare temp file                                                                                      |
| > 300 chars, ≤ 32,767 chars | Any         | Single bare temp file — no instruction wrapper                                                                          |
| > 32,767 chars              | Any         | Single bare temp file (same as above — the temp file path on the command line is short; only the file content is large) |

The temp file path (`@.flightpath/temp/<timestamp>-<name>.prompt.md`) is always short enough to fit on the command line, regardless of how long the file's content is. So for rawPromptMode, a prompt of any length is handled safely: short + safe chars → inline, anything else → one bare temp file.

There is no distinct "> 32767 chars" error case because the long content goes into a file, not onto the command line. The 32767 limit only constrains what can be passed **inline**, and we cap inline at 300 chars by design.

## Testing

- **Unit tests for `CliPromptPreparer`**: Add test case where `rawPromptMode: true` — verify no temp files are created, no context refs expanded, output equals raw input.
- **Unit tests for `PropertyResolver`**: Verify three-tier resolution: prompt overrides workflow; workflow overrides default (`false`); no settings tier.
- **Unit tests for `PromptFileParser`**: Verify `rawPromptMode` is parsed at both prompt and workflow level.
- **Manual test**: Create a workflow with a prompt containing `@src/foo.ts` and `rawPromptMode: true` — confirm the literal string `@src/foo.ts` reaches the harness unchanged.
- **Manual test**: Set `rawPromptMode: true` on a prompt longer than 300 chars — confirm it uses a single bare temp file with no instruction wrapper.

## Non-Goals

- No VS Code settings toggle. Raw mode is always explicit and per-workflow.
- No UI in the dashboard editor (not needed for initial implementation).
- `copilot-cli` inject mode compatibility: if the raw prompt text is injected into an interactive terminal session, it follows the same inject path as simple prompts — no special handling needed.
