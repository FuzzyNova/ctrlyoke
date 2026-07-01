# VS Code Language Model API — Feature Research

**Date:** 2026-03-24
**Purpose:** Research `vscode.lm` capabilities and how they could enhance ctrlyoke's prompt editor with an "Improve Prompt" button, smart completions, and other AI-powered features.

---

## 1. The `vscode.lm` API

The VS Code Language Model API (`vscode.lm`) lets extensions access AI language models that are already available in the user's VS Code instance — primarily through GitHub Copilot. These calls are made from the **extension host** (not from webview code).

### Key APIs

```typescript
// Select an available model
const [model] = await vscode.lm.selectChatModels({
  vendor: "copilot",
  family: "gpt-4o-mini", // or 'gpt-4o', 'claude-3.5-sonnet', 'o1', 'o1-mini'
});

// Build messages (only User and Assistant roles — no system role)
const messages = [
  vscode.LanguageModelChatMessage.User(
    "You are a prompt engineering assistant..."
  ),
  vscode.LanguageModelChatMessage.User(currentPromptText),
];

// Send request with cancellation support
const response = await model.sendRequest(messages, {}, cancellationToken);

// Stream the response
let result = "";
for await (const chunk of response.text) {
  result += chunk;
}

// Count tokens before sending (useful for editor hints)
const tokenCount = await model.countTokens(messages, cancellationToken);
```

### Available Model Families (via Copilot)

| Family              | Speed  | Quality | Best for                               |
| ------------------- | ------ | ------- | -------------------------------------- |
| `gpt-4o-mini`       | Fast   | Good    | Prompt improvement, short completions  |
| `gpt-4o`            | Medium | High    | Complex rewrites, multi-step reasoning |
| `o1-mini`           | Medium | High    | Reasoning tasks                        |
| `claude-3.5-sonnet` | Medium | High    | Long-form prompt rewriting             |

**Important:** The user must have GitHub Copilot active. `selectChatModels()` returns an empty array if no matching model is available — always guard against this. Models like `gpt-4o-mini` are included with Copilot Free tier, making them effectively "always available" for Copilot users.

### Architectural Constraint

The webview (`CodeMirrorEditor.tsx`, React components) **cannot** call `vscode.lm` directly. All LM requests must be:

1. Triggered by the webview via `vscode.postMessage({ type: 'SOME_REQUEST', ... })`
2. Handled in the extension host (e.g., `CtrlYokeWebviewProvider.ts`)
3. Results streamed back via `panel.webview.postMessage({ type: 'SOME_RESPONSE', chunk: '...' })`

This is the same pattern already used for completions (`REQUEST_COMPLETIONS` / `COMPLETIONS_RESPONSE`).

---

## 2. "Improve Prompt" Button

The highest-value feature. A button (or toolbar action) in the prompt editor that rewrites the current prompt to be clearer, more specific, and better structured for AI coding assistants.

### Option A — vscode.lm (Built-in, Recommended)

Call `vscode.lm` directly from the extension host using whichever free Copilot model is available.

**Flow:**

```
User clicks "Improve Prompt"
  → webview postMessage({ type: 'IMPROVE_PROMPT_REQUEST', prompt: currentText })
  → CtrlYokeWebviewProvider receives message
  → selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' })
  → sendRequest([system context, user prompt], {}, token)
  → stream chunks back: postMessage({ type: 'IMPROVE_PROMPT_CHUNK', chunk })
  → webview streams text into editor (replaces content as it arrives)
  → postMessage({ type: 'IMPROVE_PROMPT_DONE' })
```

**System prompt for improvement:**

```
You are a prompt engineering assistant for AI coding workflows.
Rewrite the following prompt to be clearer, more specific, and better structured
for an AI coding assistant. Preserve all intent and technical requirements.
Return ONLY the improved prompt text with no explanation or preamble.
```

**Editor UX during streaming:**

- Editor goes read-only, shows a spinner/loading state
- Improved text streams in and replaces current content progressively
- "Cancel" button sends cancellation token
- On completion, editor returns to editable, user can undo (single undo step) to restore original

**Undo support:** Before replacing, save original text; on `IMPROVE_PROMPT_DONE`, push the replacement as a single CodeMirror transaction so Ctrl+Z restores the original in one step.

### Option B — Configured Harness (Headless Mode)

Instead of `vscode.lm`, route the improvement request through a user-selected ctrlyoke harness in headless mode.

**Flow:**

```
User clicks "Improve Prompt"
  → CtrlYokeManager.runHeadless(improvePromptHarness, systemPrompt + currentText)
  → Returns improved text when complete
  → Webview replaces editor content
```

**Settings required:**

- `ctrlyoke.improvePromptHarness` — harness ID to use (e.g., `claude-cli`, `copilot-cli`)
- `ctrlyoke.improvePromptModel` — model override for the improve harness
- A "Improve Prompt settings" gear icon next to the button to open these settings

**Tradeoffs vs Option A:**

|                   | vscode.lm (Option A)           | Harness Headless (Option B)       |
| ----------------- | ------------------------------ | --------------------------------- |
| Setup required    | None (works if Copilot active) | User must configure which harness |
| Model flexibility | Copilot models only            | Any supported CLI harness         |
| Speed             | Fast (API call)                | Slower (spawns CLI process)       |
| Streaming         | Easy                           | Harder (CLI output parsing)       |
| Works offline     | No                             | Depends on harness                |
| Good for          | Default "just works"           | Power users with preferred models |

### Recommended Approach: Option A with Option B as Fallback

Implement Option A (`vscode.lm`) as the default. Add a settings toggle so users can switch to a configured harness (Option B) for the improvement action. The button's tooltip could indicate which mode is active.

---

## 3. Smart AI Completions in the Editor

The editor already has completions for `@file`, `#selection`, and `~git` references via extension host dispatch. These are structural completions. AI-powered completions would add a different layer.

### Option A — LM-Powered Inline Ghost Text

Use CodeMirror's inline completion / decoration system to show ghost-text suggestions as the user types (similar to Copilot inline completions in code editors, but for natural language prompts).

**Trigger:** After the user pauses typing for ~600ms, send the current prompt to `vscode.lm` with a completion instruction:

```
Complete the following prompt for an AI coding assistant.
Return only the completion text to append (not the full prompt).
Keep it concise (1-2 sentences max).

Current prompt: <text up to cursor>
```

**Rendering:** Use a CodeMirror `ViewPlugin` with a `Decoration.widget` (or `Decoration.mark`) to render ghost text after the cursor in a muted color. Accepting: `Tab` key appends the completion.

**Architecture:**

```
User pauses typing (debounce 600ms)
  → postMessage({ type: 'LM_INLINE_COMPLETION_REQUEST', textBefore, textAfter, seq })
  → Extension: selectChatModels → sendRequest
  → postMessage({ type: 'LM_INLINE_COMPLETION_RESPONSE', text, seq })
  → CodeMirror ViewPlugin renders ghost text decoration
  → Tab key: dispatch transaction inserting the ghost text
```

**Seq number:** Critical — the existing completion infrastructure already uses `completionSeqRef` to discard stale responses. The same pattern applies here.

### Option B — LM-Enhanced Autocomplete Dropdown

Augment the existing autocomplete dropdown with AI-suggested completions alongside the structural `@`/`#`/`~` completions. These would appear as a separate section labeled "AI suggestions."

**Less ideal than Option A** — inline ghost text is more natural for prose/prompt editing than a dropdown. Dropdowns work well for structured token completions but feel clunky for sentence-level suggestions.

### Option C — "Complete Prompt" Button Action

Instead of automatic inline suggestions, a discrete button/command that asks the LM to complete or extend the current partial prompt. Less intrusive — no debounce/streaming needed during typing.

**Recommended:** Start with Option C (lowest complexity, no latency concerns during typing), then graduate to Option A once the plumbing is in place.

---

## 4. Token Counter / Budget Indicator

`model.countTokens()` enables a live token count display in the editor UI.

**Feature:** A small indicator below or beside the editor showing estimated token count for the current prompt text. Could include a colored bar that shifts from green → yellow → red as the prompt approaches typical model context limits.

**Implementation:**

- Debounce token count requests (500ms after last keystroke)
- Request via `postMessage({ type: 'COUNT_TOKENS_REQUEST', text })`
- Extension calls `model.countTokens(messages, token)` and returns count
- Display in the editor footer/toolbar: `~342 tokens`

**Value:** Helps users understand prompt cost before running an expensive workflow. Especially useful for prompts with large `@file` references.

---

## 5. "Explain This Prompt" / AI Hints

A hover or sidebar panel showing what the current prompt will likely instruct the AI to do — useful for debugging complex or inherited workflows.

**Trigger:** A "?" or "Explain" button that sends the prompt through `vscode.lm` with:

```
Briefly explain in 2-3 bullet points what this AI coding prompt is instructing
the assistant to do. Be concise and specific.
```

**Display:** Could render in a VS Code notification, information message, or a panel section in the dashboard. Lower priority than "Improve Prompt" but useful for onboarding users to existing workflows.

---

## 6. Implementation Architecture

### New Message Types (to add to `DashboardConstants.ts`)

```typescript
// Improve Prompt
IMPROVE_PROMPT_REQUEST: 'improvePromptRequest',
IMPROVE_PROMPT_CHUNK: 'improvePromptChunk',
IMPROVE_PROMPT_DONE: 'improvePromptDone',
IMPROVE_PROMPT_ERROR: 'improvePromptError',

// LM Inline Completions
LM_COMPLETION_REQUEST: 'lmCompletionRequest',
LM_COMPLETION_RESPONSE: 'lmCompletionResponse',

// Token Counting
COUNT_TOKENS_REQUEST: 'countTokensRequest',
COUNT_TOKENS_RESPONSE: 'countTokensResponse',
```

### New Extension-Side Handler (in `CtrlYokeWebviewProvider.ts`)

A new `LmFeatureHandler` class (or methods added to the existing webview provider) that:

1. Receives the above message types from the webview
2. Calls `vscode.lm.selectChatModels` with fallback handling
3. Streams results back via `panel.webview.postMessage`
4. Manages `CancellationTokenSource` instances so requests can be cancelled

### New Settings (in `package.json` + `ConfigurationUtils.ts`)

```jsonc
"ctrlyoke.improvePromptEnabled": {
  "type": "boolean",
  "default": true,
  "description": "Show an 'Improve Prompt' button in the prompt editor."
},
"ctrlyoke.improvePromptSource": {
  "type": "string",
  "enum": ["vscode-lm", "harness"],
  "default": "vscode-lm",
  "description": "Whether to use VS Code's built-in language models or a configured harness for prompt improvement."
},
"ctrlyoke.improvePromptHarness": {
  "type": "string",
  "description": "Harness to use for prompt improvement when source is 'harness'."
},
"ctrlyoke.improvePromptModel": {
  "type": "string",
  "description": "Model override for the prompt improvement harness."
},
"ctrlyoke.lmInlineCompletions": {
  "type": "boolean",
  "default": false,
  "description": "Enable AI-powered inline completions in the prompt editor (experimental)."
}
```

---

## 7. Recommended Implementation Order

| Priority | Feature                                       | Complexity | Value      |
| -------- | --------------------------------------------- | ---------- | ---------- |
| 1        | "Improve Prompt" button (vscode.lm, Option A) | Medium     | Very High  |
| 2        | Token counter indicator                       | Low        | High       |
| 3        | Harness-based improve prompt (Option B)       | Medium     | Medium     |
| 4        | "Complete Prompt" button (Option C)           | Low-Medium | Medium     |
| 5        | Inline ghost text completions (Option A)      | High       | Medium     |
| 6        | "Explain Prompt" hints                        | Low        | Low-Medium |

Start with the "Improve Prompt" button — it has the clearest UX, the most obvious value for ctrlyoke users who iterate on prompts, and the infrastructure it builds (vscode.lm request/stream/response pipeline) directly enables every other feature on this list.

---

## 8. References

- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- [AI Extensibility Overview](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview)
- [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools)
- [Language Model API Tutorial](https://code.visualstudio.com/api/extension-guides/ai/language-model-tutorial)
