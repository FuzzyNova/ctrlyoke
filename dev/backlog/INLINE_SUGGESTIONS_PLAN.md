# Inline AI Suggestions in CodeMirror Editor — Implementation Plan

## Problem

The CodeMirror prompt editor (`CodeMirrorEditor.tsx`) currently supports structural completions (`@file`, `#selection`, `~git`) via a dropdown autocomplete, but has no way to show predictive "ghost text" suggestions — the inline gray-text completions that VS Code's Copilot and other modern editors provide. This would be valuable for prompt authoring, where an LM could suggest the next sentence or paragraph as the user types.

The `vscode.lm` API research in `VSCODE_LM_API_FEATURES.md` identified this as "Option A — LM-Powered Inline Ghost Text" — the highest-value follow-on feature after "Improve Prompt."

---

## Design

### Approach: `codemirror-extension-inline-suggestion`

Use the community package [`codemirror-extension-inline-suggestion`](https://github.com/saminzadeh/codemirror-extension-inline-suggestion) rather than building from scratch. It handles all CodeMirror-specific rendering, Tab acceptance, debounce logic, and state management as a single extension.

**What the package provides:**

| Primitive | Role |
|-----------|------|
| `inlineSuggestion({ fetchFn, delay })` | Top-level extension factory |
| `InlineSuggestionState` (`StateField`) | Stores the active suggestion string |
| `fetchSuggestion` (`ViewPlugin`) | Listens for `docChanged`, calls `fetchFn` (debounced), dispatches effect |
| `renderInlineSuggestionPlugin` (`ViewPlugin`) | Renders ghost text via `Decoration.widget` with `opacity: 0.4` |
| `inlineSuggestionKeymap` | `Prec.highest` Tab binding — inserts suggestion or defers to other handlers |

**How it works:**

1. User types, pauses for `delay` ms
2. `fetchFn(state)` is called with the current editor state
3. `fetchFn` returns a `Promise<string>` (the suggested text to show as ghost)
4. If the document hasn't changed since the request, the ghost text renders at the cursor
5. User presses `Tab` → suggestion is inserted as a single undo step
6. User keeps typing → suggestion is dismissed (document no longer matches)

---

## Implementation Steps

### Step 1: Install the package

```bash
npm install codemirror-extension-inline-suggestion
```

The package is small (~200 lines), has no dependencies beyond CodeMirror 6, and is compatible with the existing `@codemirror/*` v6 packages in `package.json`.

---

### Step 2: Add new settings (package.json + ConfigurationUtils.ts)

```jsonc
// package.json → contributes.configuration.properties
"flightpath.inlineSuggestionsEnabled": {
  "type": "boolean",
  "default": false,
  "description": "Enable AI-powered inline ghost text suggestions in the prompt editor (experimental)."
},
"flightpath.inlineSuggestionsDelay": {
  "type": "number",
  "default": 600,
  "minimum": 200,
  "maximum": 3000,
  "description": "Milliseconds to wait after typing stops before fetching an inline suggestion."
},
"flightpath.inlineSuggestionsModel": {
  "type": "string",
  "default": "",
  "description": "Model override for inline suggestions (e.g., 'gpt-4o-mini'). Empty = auto-select fastest available."
}
```

In `ConfigurationUtils.ts`:

```typescript
static getInlineSuggestionsEnabled(): boolean {
  return get<boolean>('inlineSuggestionsEnabled', false);
}

static getInlineSuggestionsDelay(): number {
  return get<number>('inlineSuggestionsDelay', 600);
}

static getInlineSuggestionsModel(): string {
  return get<string>('inlineSuggestionsModel', '');
}
```

---

### Step 3: Add message types (DashboardConstants.ts)

```typescript
// Inline AI Suggestions
LM_INLINE_COMPLETION_REQUEST: 'lmInlineCompletionRequest',
LM_INLINE_COMPLETION_RESPONSE: 'lmInlineCompletionResponse',
```

---

### Step 4: Create extension-side LM suggestion handler (FlightPathWebviewProvider.ts)

Add a new method or handler class that:

1. Receives `LM_INLINE_COMPLETION_REQUEST` with `{ text: string, cursorPosition: number, seq: number }`
2. Calls `vscode.lm.selectChatModels()` with fallback logic:
   - If `inlineSuggestionsModel` setting is set, try to match it
   - Otherwise, select the fastest available model (`gpt-4o-mini` preferred for speed)
   - If no model available, return empty string
3. Builds a minimal prompt:
   ```
   Continue the following prompt for an AI coding assistant.
   Return ONLY the completion text to append (not the full prompt).
   Keep it concise (1-2 sentences max).

   Current prompt: <text up to cursor>
   ```
4. Sends the request via `model.sendRequest()`, collects the streamed response
5. Returns `LM_INLINE_COMPLETION_RESPONSE` with `{ text: string, seq: number }`
6. Manages a `CancellationTokenSource` — cancels the previous request if a new one arrives before the old one completes

```typescript
// In FlightPathWebviewProvider.ts
private inlineCompletionCts: vscode.CancellationTokenSource | null = null;

private async handleInlineCompletionRequest(
  text: string,
  cursorPosition: number,
  seq: number
): Promise<void> {
  // Cancel any in-flight request
  this.inlineCompletionCts?.cancel();
  this.inlineCompletionCts = new vscode.CancellationTokenSource();

  const models = await vscode.lm.selectChatModels({
    vendor: 'copilot',
    family: 'gpt-4o-mini',
  });

  if (!models.length) {
    this.panel?.webview.postMessage({
      type: MESSAGE_TYPES.LM_INLINE_COMPLETION_RESPONSE,
      text: '',
      seq,
    });
    return;
  }

  const [model] = models;
  const textBeforeCursor = text.slice(0, cursorPosition);

  const messages = [
    vscode.LanguageModelChatMessage.User(
      `Continue the following prompt for an AI coding assistant.\nReturn ONLY the completion text to append (not the full prompt).\nKeep it concise (1-2 sentences max).\n\nCurrent prompt: ${textBeforeCursor}`
    ),
  ];

  try {
    const response = await model.sendRequest(
      messages,
      {},
      this.inlineCompletionCts.token
    );

    let result = '';
    for await (const fragment of response.text) {
      if (this.inlineCompletionCts.token.isCancellationRequested) return;
      result += fragment;
    }

    this.panel?.webview.postMessage({
      type: MESSAGE_TYPES.LM_INLINE_COMPLETION_RESPONSE,
      text: result.trim(),
      seq,
    });
  } catch (err) {
    // Silently fail — ghost text is a nice-to-have, not critical
    this.panel?.webview.postMessage({
      type: MESSAGE_TYPES.LM_INLINE_COMPLETION_RESPONSE,
      text: '',
      seq,
    });
  }
}
```

---

### Step 5: Wire the extension into CodeMirrorEditor.tsx

Add the `inlineSuggestion` extension to the editor's extensions array:

```typescript
import { inlineSuggestion } from "codemirror-extension-inline-suggestion";

// Inside the useEffect that creates the EditorView, in the extensions array:
inlineSuggestion({
  fetchFn: async (state: EditorState): Promise<string> => {
    const text = state.doc.toString();
    const cursorPos = state.selection.main.head;

    // Don't fetch for empty or very-short documents
    if (text.trim().length < 3) return '';

    const seq = ++inlineCompletionSeqRef.current;

    vscode.postMessage({
      type: MESSAGE_TYPES.LM_INLINE_COMPLETION_REQUEST,
      text,
      cursorPosition: cursorPos,
      seq,
    });

    // Wait for response via postMessage listener (same pattern as completions)
    return new Promise<string>((resolve) => {
      const handler = (event: MessageEvent) => {
        const msg = event.data;
        if (
          msg.type === MESSAGE_TYPES.LM_INLINE_COMPLETION_RESPONSE &&
          msg.seq === seq
        ) {
          window.removeEventListener('message', handler);
          resolve(msg.text || '');
        }
      };
      window.addEventListener('message', handler);

      // Timeout after 5 seconds — LM may be slow or unavailable
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve('');
      }, 5000);
    });
  },
  delay: 600, // default — actual value read from settings at init
}),
```

**Seq number handling:** Same pattern as existing `completionSeqRef` — a ref counter incremented before each request. The response handler checks `msg.seq === seq` to discard stale responses from earlier requests.

---

### Step 6: Add CSS for ghost text styling

The existing `createThemeExtension()` in `CodeMirrorEditor.tsx` should be extended with:

```typescript
".cm-inline-suggestion": {
  opacity: "0.4",
  color: "var(--vscode-editorGhostText-foreground)",
  pointerEvents: "none",
  whiteSpace: "pre",
},
```

This uses VS Code's built-in `editorGhostText-foreground` color token, so it automatically respects the user's theme (including custom ghost text colors set in VS Code settings).

---

### Step 7: Read settings at webview init

The `FlightPathWebviewProvider` should send the inline suggestion settings to the webview on load (same pattern as other settings). The webview can use these to:

- Conditionally add the `inlineSuggestion` extension to the editor
- Pass the configured `delay` value

Alternatively, the `fetchFn` can be a no-op when the setting is disabled — simpler, no conditional extension logic needed:

```typescript
// The extension always runs, but fetchFn returns '' immediately when disabled
fetchFn: async (state: EditorState): Promise<string> => {
  if (!inlineSuggestionsEnabled) return '';
  // ... actual logic
},
```

---

## Message Flow

```
User types → pauses (delay ms)
  → inlineSuggestion fetchFn called
  → postMessage({ type: 'lmInlineCompletionRequest', text, cursorPosition, seq })
  → FlightPathWebviewProvider receives message
  → selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' })
  → sendRequest([continuation prompt], {}, token)
  → collect response text
  → postMessage({ type: 'lmInlineCompletionResponse', text, seq })
  → fetchFn resolves with suggestion string
  → Ghost text renders at cursor (opacity: 0.4)
  → User presses Tab → suggestion inserted
  → User keeps typing → suggestion dismissed
```

---

## Files to Create/Modify

| File | Action | What |
|------|--------|------|
| `package.json` | Modify | Add 3 new settings |
| `src/utils/ConfigurationUtils.ts` | Modify | Add 3 getter methods |
| `src/types/DashboardConstants.ts` | Modify | Add 2 new message types |
| `src/ui/FlightPathWebviewProvider.ts` | Modify | Add `handleInlineCompletionRequest` method + message handler |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` | Modify | Import + add `inlineSuggestion` extension, add CSS, add `inlineCompletionSeqRef` |
| `src/ui/webview-react/types/messages.ts` | Check | May need to add types for new message payloads |
| `package.json` | Modify | Add `codemirror-extension-inline-suggestion` dependency |

---

## Edge Cases & Considerations

| Scenario | Handling |
|----------|----------|
| No Copilot model available | `fetchFn` returns `''` → no ghost text renders |
| LM request times out (>5s) | `fetchFn` resolves to `''` → suggestion dismissed |
| User types during LM request | Package automatically dismisses old suggestion (document changed) |
| User presses Tab with no suggestion | `Prec.highest` keymap returns `false` → falls through to default Tab behavior |
| Rapid typing (many fetchFn calls) | Seq number ensures only the latest response is accepted; earlier ones discarded |
| Multi-line suggestions | The package supports `\n` in suggestion text — `lineBreaks` getter reserves layout space |
| Undo | Insertion uses `userEvent: 'input.complete'` → single Ctrl+Z restores pre-suggestion state |
| Read-only mode (Improve Prompt streaming) | `fetchFn` returns `''` when editor is read-only → no ghost text overlaps with streaming |
| Settings change while editor is open | `fetchFn` checks `inlineSuggestionsEnabled` ref → stops requesting immediately |

---

## Settings Toggle UI

A simple toggle in the webview footer or settings panel:

```
[⚡] Inline Suggestions  ○ Off  ● On
```

- Toggles `flightpath.inlineSuggestionsEnabled`
- Visual indicator (lightning bolt icon) shows when active
- Could be placed next to the token counter (when implemented)

---

## Future Extensions (Not In Scope)

| Feature | Relation to This Plan |
|---------|----------------------|
| `codemirror-companion-extension` | Fork of the same package with `continue_suggesting: true` for chained completions — could upgrade later |
| `forceableInlineSuggestion` | Manual trigger (e.g., Ctrl+Space for ghost text) — same package, different API |
| "Complete Prompt" button | Discrete action vs. continuous suggestion — builds on same `vscode.lm` handler |
| Token counter indicator | Separate feature from `VSCODE_LM_API_FEATURES.md` — uses `model.countTokens()` |
| "Improve Prompt" button | Separate feature — uses same `vscode.lm` plumbing but different UX |

---

## Testing

- **Manual testing only** — `vscode.lm` requires a running VS Code Extension Host with Copilot active
- Test with Copilot enabled and disabled
- Test with different models selected
- Test Tab acceptance, Escape dismissal, typing-over-ghost-text
- Test timeout behavior (simulate slow LM response)
- Test multi-line suggestion rendering
- Test that existing `@`/`#`/`~` completions are not affected
