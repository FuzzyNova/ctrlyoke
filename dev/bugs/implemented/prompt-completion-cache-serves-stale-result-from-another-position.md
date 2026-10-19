# Prompt completion cache serves a stale result whose range belongs to another position

- **Found:** 2026-10-19 by Claude Code (log review)
- **Area:** `src/ui/webview-react/utils/promptCompletion/createPromptCompletionClient.ts`
- **Resolution:** fixed in this commit

## Symptom

While the user was typing in the dashboard prompt editor, the panel threw four uncaught CodeMirror range errors in about 350 ms. None of those keystrokes reached the store: no `editorStore changed: [promptText]` write lands between 21:37:41.179 and 21:37:45.651. The errors stopped once a fresh completion request started.

`ctrlyoke-1792346879606.log`:

```
[2026-10-18T21:37:41.683Z] ERROR: [panel] [bootstrap] window error: Uncaught RangeError: Position 720 is out of range for changeset of length 459 at .../out/ui/webview-react/assets/dashboard.js:92:3713
[2026-10-18T21:37:41.857Z] ERROR: [panel] [bootstrap] window error: Uncaught RangeError: Position 720 is out of range for changeset of length 459 ...
[2026-10-18T21:37:41.922Z] ERROR: [panel] [bootstrap] window error: Uncaught RangeError: Position 720 is out of range for changeset of length 459 ...
[2026-10-18T21:37:42.028Z] ERROR: [panel] [bootstrap] window error: Uncaught RangeError: Position 720 is out of range for changeset of length 459 ...
[2026-10-18T21:37:45.754Z] TRACE: [Dashboard] Completion response: position=264, partial=true 1 items
```

The bundle frame is `ChangeDesc.mapPos` in `@codemirror/state`. Four minutes earlier, in the same editor, a completion request was made at position 719. Its partial reply came back at once and its full reply came 11 s later:

```
[2026-10-18T21:33:43.118Z] TRACE: [Dashboard] Completion response: position=719, partial=true 1 items
[2026-10-18T21:33:54.241Z] TRACE: [Dashboard] Completion response: position=719, partial=false 501 items
```

A non-path completion result's `from` is the trigger position + 1, so this result's `from` was exactly 720. In between, at 21:36:30, the user switched to a new workflow, and the prompt became a different, shorter document (459 chars).

## Steps to Reproduce

1. In the prompt editor, type a trigger whose host reply is progressive (for example `@` with a text selection, which gives `partial=true 1 items` and then the full list), well past position 459.
2. Before the slow full reply arrives, dismiss the dropdown or move on so the cursor is no longer in that token. The full reply is then cached, but the re-triggered source returns `null` before it reaches the cache check.
3. Shorten the document, or switch to another workflow, so the doc is shorter than the old `from`. Then type the same trigger+query (an empty query after `@` is the easiest case).
4. The source serves the cached result at once with `from = 720`, and every later doc-changing transaction throws `RangeError: Position 720 is out of range for changeset of length 459`. Keystrokes are dropped until the completion state is replaced.

## Root Cause

`PromptCompletionClient` keeps one progressive-response cache, keyed only by trigger + query. The key does not include the position or the document the result was computed for:

- `createPromptCompletionClient.ts:109`: `private cache: { key: string; result: CompletionResult } | null`.
- `createPromptCompletionClient.ts:265-272`: when a full reply arrives after its partial has already resolved the CodeMirror promise, the full result is stored under `completionCacheKey(trigger, query)` and `startCompletion(view)` is fired.
- `createPromptCompletionClient.ts:127-131`: the re-triggered `customSource` returns `null` as soon as `findCustomCompletionContext` finds no trigger at the cursor. In that case the cache is neither used nor cleared. The `this.cache = null` resets at lines 140 and 148 only run past that check.
- `createPromptCompletionClient.ts:138-142`: the next time _any_ position has the same trigger+query, the cached `CompletionResult` is returned unchanged. Its `from` was fixed at request time (`promptCompletionResult.ts:304`, `from: from + 1` for non-path triggers).
- `@codemirror/autocomplete` (6.20.3, `dist/index.js:1011`, `:1030`, and the tooltip at `:875`) maps `result.from` through every later change with `tr.changes.mapPos(this.from)`. A `from` beyond the start document's length throws inside the state update. The update was dispatched from a DOM input handler, so the error is uncaught and the transaction (the keystroke) is lost.

The client lives as long as the `CodeMirrorEditor` component (`CodeMirrorEditor.tsx:692-704`), so the stale entry survives switching workflows. When the old `from` still falls inside the new document, nothing throws, but a picked item replaces the wrong range of text.

## Suggested Fix

- Add the position the request was made at to the cache entry, plus `context.state.doc` or a doc-length/revision guard. Serve the cache only when the current trigger `from` equals the cached request's `from` and the document is the one the request was made against, or a descendant of it. Otherwise drop the entry.
- Clear the cache whenever the source returns `null` (no completion context at the cursor), when the dropdown closes, and when the editor's `value` is replaced externally (the `[value]` effect at `CodeMirrorEditor.tsx:1158-1172`).
- As a backstop, clamp or reject any `CompletionResult` whose `from` exceeds `context.state.doc.length` or lies after `context.pos` before returning it.
- Add a Vitest case: progressive partial → dismiss → slow full reply → shorten doc → same trigger. Assert that no stale result is served and nothing throws.
