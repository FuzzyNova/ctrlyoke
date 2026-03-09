# Prompt Context Passing — Planning Document

**Feature:** `priorContext` — inject prior prompt outputs into subsequent prompts  
**Status:** Planning / Pre-implementation  
**Target files:** `FlightPathTypes.ts`, `schemas/prompt-schema.json`, `WorkflowExecutor.ts`, `HarnessIntegration.ts`, `PropertyResolver.ts`

---

## 1. Overview

FlightPath workflows execute prompts sequentially. Each prompt is currently sent as a self-contained unit: the AI has no memory of previous prompts' outputs unless `resumeSession: true` continues the same conversation thread.

This feature adds a `priorContext` field to `PromptItem` that controls whether and which prior prompts' **AI response text** is embedded into the current prompt before it is sent. This enables disconnected-session workflows (each prompt is a fresh session) to still carry forward relevant findings, summaries, or code changes from earlier steps.

### Why It's Valuable

- **Multi-stage analysis pipelines**: Prompt 1 analyzes architecture → Prompt 2 implements improvements based on that analysis → Prompt 3 validates the implementation using the findings from step 1.
- **Model hopping workflows**: Different prompts use different harnesses/models. A fast model does reconnaissance; a powerful model executes with that context.
- **Explicit context control**: `resumeSession: true` passes the full conversation history (including tool calls, thinking blocks, system prompt) — sometimes overkill or unavailable. `priorContext` injects only the final response text, letting the author choose the signal-to-noise ratio.
- **Audit and documentation workflows**: Use later prompts that summarize or cross-reference earlier ones without inheriting full session state.

---

## 2. UX Design Decision

### The Proposed UX (From Feature Request)

> "a numeric field where 0 means don't include anything, positive numbers mean prompt numbers before where '1-3' could mean include context from prompts 1 to 3 or '2,4' could mean include context from prompts 2 and 4, and -1 means include all"

This proposes a mixed-type string field combining numeric indexing, range notation, and special sentinel values (`0`, `-1`). Let's evaluate this and the alternatives.

---

### UX Options Evaluated

#### Option A: String With Embedded Range/List Syntax (Proposed)

```yaml
priorContext: "1-3"    # prompts 1 through 3
priorContext: "2,4"    # prompts 2 and 4
priorContext: "-1"     # all prior
priorContext: "0"      # none
```

**Pros:** Concise. Familiar from CSS/shell conventions.  
**Cons:**

- JSON Schema cannot validate range syntax (`"1-3"`) — AJV can only check `pattern` regex, not semantic validity. IntelliSense won't enumerate valid values.
- Magic numbers (`-1`, `0`) require documentation to interpret. `-1` meaning "all" is a non-obvious convention.
- Mixing number strings and range strings in one field is ambiguous when rendered in YAML (`-1` is the integer `-1` without quotes, or the string `"-1"` with).
- Hard to explain to new users. Discoverability is poor.

#### Option B: Pure Integer With Array Extension

```yaml
priorContext: -1        # all prior
priorContext: 0         # none (default)
priorContext: [1, 3]    # prompts 1 and 3
```

**Pros:** Machine-friendly. Arrays are schema-validatable.  
**Cons:**

- `-1` and `0` as magic sentinels require memorization. `0` naturally reads as "prompt zero."
- No range shorthand for contiguous blocks like 1–5.
- Mixed type in the schema (`integer | integer[]`) is valid but unusual.

#### Option C: Verbose Object Syntax

```yaml
priorContext:
  mode: range
  from: 1
  to: 3
```

**Pros:** Fully explicit, zero ambiguity, JSON Schema discriminated union is clean.  
**Cons:** Too verbose for the most common cases. A three-keyword field ("include all prior context") becomes 4 YAML lines. Authoring experience suffers significantly.

#### Option D: Boolean + Override (Simple Path)

```yaml
includeAllPriorContext: true # simplest case
```

**Pros:** Dead simple for the #1 use case.  
**Cons:** Can't express partial inclusion. Forces a second field for selective inclusion. A separate `priorContextPrompts: [1, 3]` would create an awkward two-field API.

#### Option E: Keyword String + Optional Array ✅ **RECOMMENDED**

```yaml
priorContext: all        # inject all prior prompt outputs
priorContext: previous   # inject only the immediately preceding prompt's output
priorContext: none       # explicit no-op (same as omitting the field)
priorContext: [1, 3]     # inject outputs from prompts 1 and 3 (1-based)
priorContext: [1, 2, 3]  # inject outputs from prompts 1, 2, and 3
```

**Type definition:**

```typescript
type PriorContext = "all" | "previous" | "none" | number[];
```

---

### Recommendation: Option E

**Field name:** `priorContext`

**Rationale for the field name:**

- `priorContext` is unambiguous — context from _prior_ (already-completed) prompts.
- `includeContext` is too vague (could mean file context, workspace context).
- `contextFrom` sounds like a path/source designator.
- `withContext`, `injectContext` — inconsistent with the rest of the schema's noun-style properties (`resumeSession`, `endCondition`, `sessionId`).

**Rationale for the UX:**

| Aspect                 | Decision                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| Self-documenting       | `"all"` and `"previous"` explain themselves without reading docs                                               |
| IntelliSense           | JSON Schema `enum` on the string branch enumerates `all`, `previous`, `none` as hover completions              |
| Array indices          | `[1, 3]` — explicit, no parsing required, AJV validates `integer, minimum: 1`                                  |
| No ranges              | `"1-3"` syntax dropped. Use `[1, 2, 3]` instead — slightly more verbose but schema-validatable and unambiguous |
| No magic numbers       | `-1` and `0` replaced by named keywords                                                                        |
| `"previous"` shorthand | The most common selective use-case (immediately preceding prompt) gets its own keyword                         |
| YAML ergonomics        | Single-keyword form (`priorContext: all`) reads naturally as English                                           |

**Comparison with proposed UX:**
The proposal's `"1-3"` range notation is appealing for brevity but impractical to validate in JSON Schema and non-obvious to new users. The explicit array `[1, 2, 3]` is only marginally more verbose and far more robust. The magic `-1`/`0` sentinels are replaced by self-explanatory keywords.

---

## 3. Schema Changes

### 3.1 TypeScript Interface Additions (`src/types/FlightPathTypes.ts`)

**New type alias** (add near the top of the file):

```typescript
/**
 * Controls which prior prompt outputs are injected into the current prompt as context.
 *
 * - "all": Inject all previously-completed prompt outputs
 * - "previous": Inject only the immediately preceding prompt's output
 * - "none": Explicit no-op (same as omitting the field)
 * - number[]: Inject specific prompt outputs by 1-based prompt number (e.g., [1, 3])
 *
 * Context is injected as an XML block before the user's prompt text.
 * Note: When used with resumeSession:true, context may be duplicated — this is accepted behavior.
 */
export type PriorContext = "all" | "previous" | "none" | number[];
```

**Add `priorContext` to `ExecutionProperties`:**

```typescript
export interface ExecutionProperties {
  // ... existing fields ...

  /** Controls injection of prior prompt outputs into this prompt's text.
   *  See PriorContext type for valid values. Omitting the field = no injection. */
  priorContext?: PriorContext;
}
```

**Add `responseText` to `PromptRuntimeMetadata`:**

```typescript
export interface PromptRuntimeMetadata extends ExecutionProperties {
  startedAt: number;
  completedAt?: number;
  retryCount?: number;

  /** The plain-text AI response from this prompt's execution.
   *  Stored here to enable priorContext injection in subsequent prompts.
   *  Also persists across pause/resume cycles via the working file. */
  responseText?: string;
}
```

### 3.2 JSON Schema Changes (`schemas/prompt-schema.json`)

**Add `priorContext` to `executionProperties` definition:**

```json
"priorContext": {
  "description": "Controls injection of prior prompt outputs into this prompt's text before sending to the AI. 'all' injects all prior outputs; 'previous' injects the immediately preceding output; 'none' disables injection; an array of integers ([1, 3]) injects specific prompts by 1-based index. When omitted, no context is injected. Note: combining with resumeSession:true may duplicate context (accepted limitation).",
  "oneOf": [
    {
      "type": "string",
      "enum": ["all", "previous", "none"],
      "description": "Keyword shorthand: 'all' = all prior prompts, 'previous' = immediately preceding prompt, 'none' = no injection"
    },
    {
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 1,
        "description": "1-based prompt number"
      },
      "minItems": 1,
      "description": "Specific prior prompt numbers to include (1-based, e.g. [1, 3] includes prompts 1 and 3)"
    }
  ]
}
```

**Add `responseText` to `promptRuntimeMetadata` definition:**

```json
"responseText": {
  "type": "string",
  "description": "Plain-text AI response from this prompt's execution. Written automatically during workflow execution. Used by the priorContext feature to inject prior prompt outputs."
}
```

### 3.3 `PropertyResolver` Changes (`src/utils/PropertyResolver.ts`)

Add `priorContext` to `ResolvedProperties` and resolve it with prompt-level-only precedence (no global setting fallback, since there's no sensible default):

```typescript
// In ResolvedProperties interface:
priorContext?: PriorContext;   // undefined = no injection

// In PropertyResolver.resolve():
priorContext: prompt.priorContext ?? workflow.priorContext,
```

This allows workflow-level `priorContext` defaults if needed, but the common case is per-prompt.

---

## 4. YAML Examples

### Example 1: Multi-Stage Analysis Pipeline

```yaml
harness: claude-cli
model: claude-sonnet-4.5
prompts:
  - name: Analyze Architecture
    prompt: |
      Analyze the current codebase architecture in src/.
      List the key components, their responsibilities, and any coupling issues.

  - name: Design Improvements
    prompt: |
      Based on the architectural analysis above, propose specific refactoring improvements.
      Focus on reducing coupling and improving testability.
    priorContext: previous # Inject prompt 1's architectural analysis

  - name: Implement Refactoring
    prompt: |
      Implement the refactoring improvements. Make the actual code changes.
    priorContext: [1, 2] # Inject both the analysis AND the design plan
```

### Example 2: Include All Prior Context

```yaml
prompts:
  - name: Gather Dependencies
    prompt: List all npm dependencies and their purposes.

  - name: Assess Security
    prompt: Identify known security vulnerabilities in the dependencies listed above.
    priorContext: previous

  - name: Generate Report
    prompt: Write a comprehensive security audit report.
    priorContext: all # Include dependency list AND vulnerability assessment
```

### Example 3: Model-Hopping Workflow

```yaml
prompts:
  - name: Fast Recon
    harness: copilot-cli
    model: gpt-5-mini
    prompt: |
      Quickly list all TypeScript files in src/ that have more than 200 lines.
      Output just the file paths, one per line.

  - name: Deep Analysis
    harness: claude-cli
    model: claude-sonnet-4.5
    prompt: |
      Analyze these large TypeScript files for complexity issues and refactoring opportunities.
    priorContext: previous # Pass the file list from the fast recon step
```

### Example 4: Explicit No Injection (for documentation clarity)

```yaml
prompts:
  - name: Step 1
    prompt: Analyze authentication code.

  - name: Step 2
    prompt: Fix the authentication vulnerabilities.
    priorContext: none # Explicit: do NOT inject step 1's output (resumeSession provides history)
    resumeSession: true
```

### Example 5: Selective Context (Skip Middle Prompts)

```yaml
prompts:
  - name: Initial Scan
    prompt: Scan for all TODO comments in the codebase.

  - name: Categorize TODOs
    prompt: Group the TODO comments by priority.
    priorContext: previous

  - name: Intermediate Step
    prompt: Fix all 'high-priority' TODOs.
    resumeSession: true

  - name: Final Summary
    prompt: Write a completion report summarizing what was done.
    priorContext: [1, 2] # Inject the original scan + categorization, skip step 3's output
```

---

## 5. Technical Architecture

### 5.1 Execution Pipeline — Where Context Is Injected

The existing prompt building pipeline in `HarnessIntegration.buildPromptWithInstructions()`:

```
1. buildPromptText(prompt, resolvedAgent, resolvedSkills)
   ├── ContextExpander.expandContext()      (#file:, @workspace → inlined content)
   ├── insertAgentInstructions()            (<agentInstructions>...</agentInstructions>)
   └── insertSkillInstructions()            (<skillInstructions>...</skillInstructions>)

2. [NEW] insertPriorContext()               (<priorContext>...</priorContext>)

3. MCP/Dynamic queue instructions          (<criticalInstruction>...</criticalInstruction>)
```

**Injection point:** Between steps 1 and 3, inside `buildPromptWithInstructions()`.

This method already receives `prompt: PromptItem`, `promptIndex: number`, and `allPrompts: PromptItem[]` — exactly the parameters needed for context injection. No changes to the method signature are required.

**Why not inject in `buildPromptText()`?**  
`buildPromptText` handles the core prompt content transformation (file expansion, agent, skills). It's a lower-level building block meant to produce the core prompt text. Prior context is a higher-level orchestration concern — it's about composing the multi-prompt workflow, not about expanding the individual prompt's references. `buildPromptWithInstructions` is the correct single place for both workflow-level injections (dynamic queue and prior context).

**Why not inject in `WorkflowExecutor`?**  
Context injection must happen before the prompt is sent to the CLI. WorkflowExecutor doesn't build prompt text — it calls `integration.sendPrompt()` which delegates to `buildPromptWithInstructions`. Keeping injection in `HarnessIntegration` ensures it works for all harnesses (CLI and Chat) via the shared base class.

### 5.2 The `insertPriorContext()` Method

New private method in `HarnessIntegration`:

```typescript
/**
 * Gather prior prompt response texts based on the priorContext field.
 * Returns an array of { index, name, text } objects (0-based indices).
 * Prompts with no responseText in _runtime are silently skipped.
 */
private gatherPriorContextItems(
  priorContext: PriorContext,
  allPrompts: PromptItem[],
  currentIndex: number  // 0-based
): { index: number; name?: string; text: string }[] {
  let targetIndices: number[];

  if (priorContext === "none") {
    return [];
  } else if (priorContext === "all") {
    targetIndices = Array.from({ length: currentIndex }, (_, i) => i);
  } else if (priorContext === "previous") {
    targetIndices = currentIndex > 0 ? [currentIndex - 1] : [];
  } else {
    // Array of 1-based prompt numbers → 0-based indices, validated
    targetIndices = priorContext
      .map(n => n - 1)                              // convert to 0-based
      .filter(i => i >= 0 && i < currentIndex);     // only valid prior prompts
  }

  return targetIndices
    .map(i => ({
      index: i,
      name: allPrompts[i]?.name,
      text: allPrompts[i]?._runtime?.responseText ?? "",
    }))
    .filter(item => item.text.length > 0);           // skip prompts with no captured output
}

/**
 * Format gathered context items as an XML block and prepend to prompt text.
 * Result is inserted BEFORE the user's prompt text.
 */
private insertPriorContext(
  promptText: string,
  contextItems: { index: number; name?: string; text: string }[]
): string {
  if (contextItems.length === 0) {
    return promptText;
  }

  const steps = contextItems
    .map(item => {
      const nameAttr = item.name ? ` name="${item.name}"` : "";
      return `<step index="${item.index + 1}"${nameAttr}>\n${item.text.trim()}\n</step>`;
    })
    .join("\n");

  const contextBlock = `<priorContext>\n${steps}\n</priorContext>`;
  return `${contextBlock}\n\n${promptText}`;
}
```

### 5.3 Updated `buildPromptWithInstructions()` Signature

The method currently accepts `resolvedProperties?.allowDynamicExtension`. Add parallel handling for `priorContext`:

```typescript
protected async buildPromptWithInstructions(
  prompt: PromptItem,
  promptIndex: number,
  allPrompts: PromptItem[],
  allowDynamicExtension?: boolean,
  resolvedAgent?: string,
  resolvedSkills?: string[],
  resolvedPriorContext?: PriorContext   // NEW parameter
): Promise<string> {
  // Build base prompt text (existing)
  let promptText = await this.buildPromptText(prompt, resolvedAgent, resolvedSkills);

  // NEW: Inject prior context if specified
  if (resolvedPriorContext !== undefined && resolvedPriorContext !== "none") {
    const contextItems = this.gatherPriorContextItems(
      resolvedPriorContext,
      allPrompts,
      promptIndex
    );
    if (contextItems.length > 0) {
      promptText = this.insertPriorContext(promptText, contextItems);
      Log.debug(
        `🔗 Injecting prior context for prompt ${promptIndex + 1}: ` +
        `${contextItems.length} step(s) from indices [${contextItems.map(c => c.index + 1).join(", ")}]`
      );
    } else {
      Log.debug(
        `🔗 priorContext specified for prompt ${promptIndex + 1} but no prior outputs available yet`
      );
    }
  }

  // Existing: MCP/dynamic queue instructions
  // ... (rest of method unchanged)
}
```

### 5.4 Call Site in `CliIntegration.sendPrompt()`

Update the `buildPromptWithInstructions` call to pass `resolvedProperties?.priorContext`:

```typescript
const finalPromptText = await this.buildPromptWithInstructions(
  prompt,
  workflowContext?.promptIndex ?? 0,
  workflowContext?.allPrompts ?? [prompt],
  resolvedProperties?.allowDynamicExtension,
  resolvedProperties?.agent,
  resolvedProperties?.skills,
  resolvedProperties?.priorContext // NEW
);
```

### 5.5 `CopilotChatIntegration` Compatibility

`CopilotChatIntegration` overrides `buildPromptText()` but calls `super.buildPromptText()`. It does NOT override `buildPromptWithInstructions()`, so the new context injection code in the base class will automatically apply to the Chat harness as well. No changes needed in `CopilotChatIntegration`.

---

## 6. Context Format

### Injected XML Block Structure

```xml
<priorContext>
<step index="1" name="Analyze Architecture">
The codebase uses a monolithic Express.js server with all routes in a single file (server.js, 847 lines). Key issues identified:

1. No separation between business logic and route handlers
2. Direct database calls in route handlers (14 instances)
3. No input validation middleware
4. Hardcoded configuration values in 6 places
</step>
<step index="2" name="Design Improvements">
Recommended refactoring plan:

1. Extract route handlers to controllers/
2. Create a service layer for business logic
3. Add express-validator middleware for input validation
4. Move config to environment variables with dotenv
</step>
</priorContext>

Implement the refactoring improvements. Make the actual code changes.
```

### Format Decisions

| Decision                     | Rationale                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| XML `<priorContext>` wrapper | Consistent with `<agentInstructions>`, `<skillInstructions>`, `<criticalInstruction>` XML conventions already used in the codebase                  |
| `index` attribute (1-based)  | Matches user-facing prompt numbering and the YAML `priorContext: [1, 2]` indices                                                                    |
| Optional `name` attribute    | Included when `PromptItem.name` is set; helps the AI identify which step produced which output                                                      |
| Prepend (before user prompt) | Context/background goes first, instruction goes last — standard AI prompting convention                                                             |
| Plain text response          | No Markdown processing, just the raw response text from the AI. Structured output (tool call blocks) is NOT included — only the final text response |

### Handling Structured Output (Non-Text Harnesses)

Some harnesses (Claude CLI, Codex CLI) capture structured output (tool calls, thinking blocks) in addition to plain text. The `responseText` stored in `_runtime` is always the plain text response (the final assistant message text), not the full structured output. This is intentional:

- Structured events (tool call JSON) would be overwhelming and confusing to inject into a fresh prompt
- The final text response is the "answer" — what a human would read and act upon
- This matches `CliOutput.response` which is already plain text

---

## 7. Context Storage

### Where Prompt Outputs Live Today

| Storage Location                               | What's Stored                            | Persistent?                | Available For Context Injection?                  |
| ---------------------------------------------- | ---------------------------------------- | -------------------------- | ------------------------------------------------- |
| `CliOutput.response` (dashboard state)         | Plain text response                      | In-memory only             | No (lost on VS Code restart)                      |
| `OutputHistoryManager` (.flightpath/.history/) | `CliOutput[]` per step                   | On disk                    | Possible but complex (async I/O, may be disabled) |
| `PromptItem._runtime` (working file)           | `startedAt`, `completedAt`, `retryCount` | On disk (working file)     | **Not yet**                                       |
| `WorkflowExecutor` local variable              | `responseText` string                    | In-memory, loop scope only | No                                                |

**Current problem:** `PromptRuntimeMetadata` stores execution timing metadata but NOT the response text. The response text is only available as a local variable during `WorkflowExecutor.execute()` and then persisted to the dashboard/history — but not to the working file.

### Solution: Store `responseText` on `PromptItem._runtime`

After `const { responseText, duration } = result;` in `WorkflowExecutor.execute()`, store the response on the prompt's runtime metadata:

```typescript
// Store response text for priorContext injection in subsequent prompts
if (!prompt._runtime) {
  prompt._runtime = { startedAt: Date.now() };
}
prompt._runtime.responseText = responseText;

// Persist to working file so it survives pause/resume
await this.promptQueue.persistRuntimeMetadata(i, { responseText });
```

This stores the raw response text in the in-memory `PromptItem` objects and flushes it to the working file's JSON. Subsequent prompts in the same run access it via `allPrompts[i]._runtime?.responseText`.

### Why Not Use OutputHistoryManager?

1. **May be disabled** — `isSaveOutputHistoryEnabled()` is a user setting; context injection must work regardless.
2. **Async disk I/O per step** — Adds latency and complexity in the injection hot-path.
3. **Different data format** — History stores `CliOutput[]` (with attempt arrays, status messages), requiring extraction logic.
4. **Not designed for this** — History is an audit log, not an inter-prompt communication channel.

### `_runtime.responseText` is the Right Approach Because:

1. **Always available** — Written unconditionally after every successful prompt.
2. **Survives pause/resume** — Persisted to working file; survives VS Code restart mid-workflow.
3. **Zero new dependencies** — Already reads/writes `_runtime` fields.
4. **In-memory access** — No I/O in the injection path; `allPrompts[i]._runtime.responseText` is a simple property access.

### Persistence: `PromptQueue.persistRuntimeMetadata()`

Add a new method to `PromptQueue` that merges partial `_runtime` updates into the working file without overwriting other fields:

```typescript
async persistRuntimeMetadata(
  promptIndex: number,
  updates: Partial<PromptRuntimeMetadata>
): Promise<void> {
  const prompt = this.state.prompts[promptIndex];
  if (!prompt) return;

  // Merge updates into existing _runtime
  prompt._runtime = { ...(prompt._runtime ?? { startedAt: Date.now() }), ...updates };

  // Flush to disk — working file always reflects latest state
  await this.updateWorkingFile();
}
```

### Response Text Size Considerations

AI responses can range from a few words to tens of thousands of tokens. Injecting very large prior outputs could:

1. Exceed the AI model's context window
2. Significantly increase token costs
3. Dilute the signal with noise

**Initial implementation:** No truncation. Store and inject the full `responseText`. This is the simplest correct behavior and matches user expectations (they chose to inject that output).

**Future enhancement (not in this plan):** Add a `priorContextMaxLength` field (characters) or rely on the context window limit of the model. The AI CLI harnesses handle context window overflow gracefully on their own (they'll error if tokens exceed limit, which signals the user to be more selective in what they inject).

---

## 8. Edge Cases & Error Handling

### 8.1 Referencing a Future Prompt

```yaml
prompts:
  - name: Step 1
    prompt: Do task A.
  - name: Step 2
    prompt: Do task B.
    priorContext: [1, 5] # Prompt 5 doesn't exist yet!
```

**Behavior:** The `gatherPriorContextItems()` filter `i < currentIndex` silently ignores out-of-range indices. Only prompt 1's output (if available) is injected. Prompt 5 is silently skipped.

**Log warning:** `Log.warn("priorContext: index 5 is out of range for prompt 2 (only 1 prompt has run). Skipping.")`

### 8.2 Referenced Prompt Has No Output

If a prior prompt completed but its `_runtime.responseText` is empty or undefined (e.g., the harness produced no text response, or it was a resumed session whose output wasn't captured), the `filter(item => item.text.length > 0)` step silently skips it.

**Log info:** `Log.debug("priorContext: prompt 1 has no captured response text, skipping injection.")`

This is non-fatal. The user may not realize there's no text to inject — a warning would be useful if ALL specified prompts have no output (meaning the injection was a no-op).

### 8.3 First Prompt With `priorContext`

If the first prompt (`promptIndex = 0`) specifies `priorContext: all` or `priorContext: previous`, there are no prior prompts to inject. `gatherPriorContextItems` returns `[]`, no XML block is added, and the prompt runs as normal. No error.

### 8.4 `priorContext: previous` on Prompt Index 0

Same as 8.3 — returns empty result, prompt runs without context injection. Silent no-op.

### 8.5 Workflow Resume After Pause

When a workflow resumes after pause (via `workingFile` reload), `PromptItem._runtime.responseText` is already persisted in the working file from before the pause. The `allPrompts` array in the restored queue has the correct `_runtime` values. Context injection for the resumed prompt will work correctly.

### 8.6 `resumeSession: true` + `priorContext` Duplicate Context

When a prompt sets both `resumeSession: true` AND `priorContext: all`, the AI receives:

- The full conversation history from the resumed session (via the CLI's built-in session resumption)
- An explicit `<priorContext>` XML block injected by FlightPath with prior response texts

This **may duplicate context** — the AI has the prior responses in both the session history AND the injected block. This is an **accepted limitation** documented in the schema field description. Users who call both are presumably doing so intentionally (e.g., to emphasize specific prior outputs). FlightPath will not attempt to detect or prevent this.

### 8.7 Very Large Response Texts

If `responseText` is 50,000+ characters and the user injects `priorContext: all` for late prompts in a long workflow, the combined prompt could exceed the model's context window limit. The AI CLI harness will return an error or truncate — behavior depends on the harness. FlightPath will propagate the failure as a normal prompt send failure.

**Mitigation (not in this plan):** A future `priorContextMaxLength` config option.

### 8.8 Prompt 10 Uses `priorContext: [10]`

A prompt referencing its own index. The filter `i < currentIndex` ensures `i = 9` (0-based) is < `10` (currentIndex for prompt 10 is 9), so... actually prompt 10 is at index 9 (0-based) and `currentIndex = 9`. The filter `i < 9` would exclude index 9. So a prompt cannot reference itself. **This is correct behavior.** Self-reference would be a circular dependency and produces no injection.

### 8.9 Non-CLI Harnesses (Copilot Chat)

`CopilotChatIntegration.sendPrompt()` does NOT call `buildPromptWithInstructions()` in the same way as `CliIntegration`. It overrides `buildPromptText()` and calls `super.buildPromptText()`. Verify that the Chat integration's `sendPrompt` path also calls `buildPromptWithInstructions` — if not, a separate code path handles context injection there.

**Action item during implementation:** Audit `CopilotChatIntegration.sendPrompt()` to confirm the injection path is exercised. Add a test case.

### 8.10 Schema Validation of `priorContext` in AJV

AJV with `draft-07` supports `oneOf` correctly. The `priorContext` schema uses:

```json
"oneOf": [
  { "type": "string", "enum": ["all", "previous", "none"] },
  { "type": "array", "items": { "type": "integer", "minimum": 1 }, "minItems": 1 }
]
```

An empty array `[]` would fail `minItems: 1` — this is intentional: `priorContext: []` is not meaningful and should be flagged as an authoring error. Use `priorContext: none` or omit the field.

---

## 9. Implementation Steps

### Phase 1: Types & Schema (No behavior change)

- [ ] **`src/types/FlightPathTypes.ts`**
  - Add `PriorContext` type alias
  - Add `priorContext?: PriorContext` to `ExecutionProperties`
  - Add `responseText?: string` to `PromptRuntimeMetadata`

- [ ] **`schemas/prompt-schema.json`**
  - Add `priorContext` property to `executionProperties` definition (`oneOf` union)
  - Add `responseText` property to `promptRuntimeMetadata` definition

- [ ] **`src/utils/PropertyResolver.ts`**
  - Add `priorContext?: PriorContext` to `ResolvedProperties` interface
  - Add `priorContext: prompt.priorContext ?? workflow.priorContext` in `resolve()`

- [ ] **Regenerate YAML schema**: `npm run generate-schema`

### Phase 2: Response Text Storage (No visible behavior change)

- [ ] **`src/flightpath/PromptQueue.ts`**
  - Add `persistRuntimeMetadata(index: number, updates: Partial<PromptRuntimeMetadata>): Promise<void>` method
  - Must merge `updates` into existing `_runtime` and call `updateWorkingFile()`

- [ ] **`src/flightpath/WorkflowExecutor.ts`**
  - After `const { responseText, duration } = result;`, call:
    ```typescript
    await this.promptQueue.persistRuntimeMetadata(i, { responseText });
    ```
  - This single line stores the response text for future prompts' context injection

### Phase 3: Context Injection (Feature becomes active)

- [ ] **`src/flightpath/HarnessIntegration.ts`**
  - Add private `gatherPriorContextItems()` method (resolves `PriorContext` to array of `{ index, name, text }`)
  - Add private `insertPriorContext()` method (formats XML block and prepends to prompt text)
  - Update `buildPromptWithInstructions()` signature: add `resolvedPriorContext?: PriorContext` parameter
  - Inside `buildPromptWithInstructions()`, call gather+insert after `buildPromptText()` and before MCP instructions

- [ ] **`src/flightpath/harness/CliIntegration.ts`**
  - Update the `buildPromptWithInstructions()` call in `sendPrompt()` to pass `resolvedProperties?.priorContext`

- [ ] **`src/flightpath/harness/chat/CopilotChatIntegration.ts`**
  - Audit the `sendPrompt` path to confirm `buildPromptWithInstructions` is called
  - If it takes a different code path, replicate the injection there

### Phase 4: Schema Validation & Regeneration

- [ ] Run `npm run sync-models` (updates `package.json` enums if any enum fields changed)
- [ ] Run `npm run generate-schema` (regenerates YAML schema from JSON)
- [ ] Verify IntelliSense works for `priorContext: all` in `.flightpath.yaml` files

### Phase 5: Tests

- [ ] Unit tests for `gatherPriorContextItems()` (all branches: `"all"`, `"previous"`, `"none"`, array, out-of-range, no-runtime, first-prompt)
- [ ] Unit tests for `insertPriorContext()` (single step, multi-step, zero steps, with/without name attribute)
- [ ] Integration test for `WorkflowExecutor` storing `responseText` on `_runtime`
- [ ] End-to-end workflow test with 3 prompts using `priorContext: all` on prompt 3

---

## 10. Testing Considerations

### Unit Tests (`src/test/`)

**`priorContextResolver.test.ts`** (new file):

```
gatherPriorContextItems
  ✓ returns [] for "none"
  ✓ returns [] for undefined
  ✓ returns all prior indices for "all" when prompts are complete
  ✓ returns only immediately preceding for "previous"
  ✓ returns [] for "previous" on prompt index 0
  ✓ returns specified indices for array form [1, 3]
  ✓ filters out-of-range indices silently (e.g. [5] on prompt 2)
  ✓ filters prompts with no _runtime.responseText
  ✓ filters prompts with empty responseText

insertPriorContext
  ✓ prepends <priorContext> block with correct XML structure
  ✓ includes name attribute when prompt has name
  ✓ omits name attribute when prompt has no name
  ✓ returns promptText unchanged when contextItems is []
  ✓ uses 1-based index in XML even for 0-based input
```

**`workflowExecutor.test.ts`** (additions):

```
responseText persistence
  ✓ writes responseText to prompt._runtime after successful execution
  ✓ writes responseText to working file via persistRuntimeMetadata
  ✓ responseText is accessible on allPrompts[i]._runtime in subsequent prompt
```

### Manual Testing Checklist

- [ ] Workflow with `priorContext: previous` — verify XML block appears at start of prompt in logs
- [ ] Workflow with `priorContext: all` — verify all prior responses are injected
- [ ] Workflow with `priorContext: [1, 3]` — verify only prompts 1 and 3 are injected
- [ ] Workflow resumed after pause — verify `responseText` survives via working file
- [ ] First prompt with `priorContext: all` — verify no XML block is injected and prompt runs normally
- [ ] Prompt with no `priorContext` — verify no regression (existing behavior unchanged)
- [ ] YAML IntelliSense — verify `all`, `previous`, `none` autocomplete in `.flightpath.yaml`

---

## 11. Known Limitations

### 11.1 Duplicate Context When Combined With `resumeSession: true`

**Situation:** A prompt sets both `resumeSession: true` and `priorContext: all`.

**What happens:** The AI receives the full conversation history (via session resumption) AND explicit `<priorContext>` XML blocks with the same response texts.

**Impact:** The AI may see duplicated information, potentially increasing token usage and causing confusion in edge cases.

**Decision:** **Accepted limitation.** This combination may have valid use cases — for example, a user wants to emphasize specific prior outputs even in a resumed session. FlightPath will not detect or prevent this. The schema field description explicitly notes this behavior. Users should omit `priorContext` when using `resumeSession: true` unless they have a specific reason to combine them.

### 11.2 No Context From Partial/Failed Prompts

Prompts that failed, were skipped, or are currently running have no `responseText` in `_runtime`. These are silently excluded from context injection. Users cannot inject the output of a failed prompt even if the AI produced partial output before failing.

**Rationale:** The design is intentional — partial outputs are unreliable and could mislead subsequent prompts.

### 11.3 Plain Text Only — No Structured Event Injection

Only the plain text response (`CliOutput.response`) is injected. Structured output (tool call sequences, thinking blocks, code blocks in structured form) is NOT available. This means some information present in the AI's "thinking process" is not captured in `responseText`.

**Rationale:** Injecting raw JSON tool call sequences would be confusing and counterproductive. Plain text response is the appropriate unit for inter-prompt context.

### 11.4 Interactive Mode Response Text May Be Empty

In interactive mode with no completion hook (user manually exits the CLI with `Ctrl+D`), no response text is captured (see `executeInteractiveCliProcess` returning `"Interactive session ended"` as the response text). Injecting this value would be misleading.

**Mitigation:** The `filter(item => item.text.length > 0)` step automatically skips empty responses. `priorContext: previous` on a headless prompt following an interactive one will silently inject nothing.

**Action item during implementation:** Consider storing `responseText = undefined` (rather than the `"Interactive session ended"` sentinel) for interactive sessions so the filter works correctly. This requires checking whether the response text equals the sentinel value before storage.

### 11.5 No Truncation for Very Large Responses

No maximum length is enforced on `responseText` storage or injection. A 100,000 character response will be injected in full. Users are responsible for being selective in what they choose to inject for long workflows.

**Future work:** `priorContextMaxLength: number` config option (characters, applied per step before injection).
