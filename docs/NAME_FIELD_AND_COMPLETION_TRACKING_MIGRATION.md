# `name` Field + Per-Prompt Completion Tracking

**Status**: ✅ IMPLEMENTED (as of February 2026)

## Summary

Two related schema changes were implemented together:

1. **Renamed `id` → `name`**: The prompt identifier field is now a human-readable display label with no machine-key constraints (no regex pattern, no length restriction below 100 chars). Spaces, punctuation, and uppercase are all allowed.

2. **Per-prompt completion tracking via `_runtime.completedAt`**: Completion is now tracked at the per-prompt level using `prompt._runtime.completedAt`. The old `WorkingFileRuntime.completedPrompts[]` array was removed entirely. The in-memory `completedIds` Set is kept as a fast-lookup cache but its keys are now prompt indices (`"0"`, `"1"`, ...) instead of `"{id}:{hash}"` strings.

---

## What Changed

### Schema (`schemas/prompt-schema.json`)

- `promptItem.id` → `promptItem.name` (no regex `pattern`, `maxLength: 100`)
- `runtimeMetadata.completedPrompts` field removed
- `runtimeMetadata.required` no longer includes `completedPrompts`

Example prompt YAML after migration:

```yaml
prompts:
  - name: "Analyze auth flow" # free text, no underscore/dash requirement
    prompt: |
      Analyze the authentication system...
```

### `src/types/FlightPathTypes.ts`

```typescript
export interface PromptItem extends ExecutionProperties {
  name?: string; // Optional human-readable display label
  prompt: string;
  sessionId?: string | number;
  _runtime?: PromptRuntimeMetadata;
}

export interface WorkingFileRuntime {
  currentIndex: number;
  executionState: ExecutionState;
  // completedPrompts[] REMOVED — per-prompt _runtime.completedAt is the source of truth
}

export interface QueueState {
  // ...
  completedIds: Set<string>; // Fast-lookup cache; keys = prompt indices as strings ("0", "1", ...)
}
```

### `src/utils/PromptIdentity.ts`

`isPromptCompleted()` was deleted. The file now contains only:

- `hashPromptContent()` — still used for content-hash matching in `mergePromptsFromDisk`
- `shouldInjectExtensionInstructions()` — unchanged

### `src/flightpath/PromptQueue.ts`

#### Restore from working file

Completion is rebuilt from per-prompt `_runtime.completedAt`:

```typescript
// Build completedIds from per-prompt _runtime.completedAt (source of truth)
if (p._runtime?.completedAt !== undefined) {
  completedIds.add(String(i));
}
```

Backward-compat: old files with `completedPrompts[]` but no per-prompt `_runtime` fall back to `currentIndex`-based completion boundary and self-heal on the next save.

#### `markPromptCompleted(index: number)`

Signature changed to take a prompt index (not a `PromptItem`). Sets `prompt._runtime.completedAt = Date.now()` and adds the index to `completedIds`.

#### `updateWorkingFile()`

No longer writes `completedPrompts[]` to the working file. Per-prompt `_runtime.completedAt` is persisted instead.

#### `reloadAndMergeQueue()` / `mergePromptsFromDisk()`

Completion checks use `prompt._runtime?.completedAt !== undefined`. Content-hash dedup for file-reload scenarios still uses `hashPromptContent()`.

### `src/mcp-server.ts`

- `validatePrompts()` uses only Check 1 (already completed via `_runtime.completedAt`). Pending-queue dedup checks (2 and 3 from old design) were removed.
- `getPromptStatus()` checks `prompts[index]?._runtime?.completedAt !== undefined`.
- `prompt.name` is exposed in prompt status output (line ~489).

### `src/flightpath/FlightPathManager.ts`

`executeEphemeralPrompt()` no longer generates a sanitized kebab-case `promptId`. The `name` field is stored as-is (the user-typed string). Working file naming still sanitizes to kebab-case (filesystem constraint, not schema constraint).

### React Webview

- `editorStore.ts`: `promptData.id` → `promptData.name`; `result.id` → `result.name`
- `workflowStore.ts` and `src/ui/webview-react/utils/prompt.ts`: local `PromptItem` types use `name`
- `PromptsPanel.tsx`: renders `prompt.name` as label when present; falls back to truncated prompt text
- `PromptItem.tsx`: `id` prop removed, `name` prop added

---

## Working File Format After Migration

```json
{
  "workflowName": "analyze-auth-flow",
  "startedAt": 1700000000000,
  "prompts": [
    {
      "name": "Analyze auth flow",
      "prompt": "Analyze the authentication system...",
      "_runtime": {
        "startedAt": 1700000001000,
        "completedAt": 1700000060000
      }
    },
    {
      "name": "Implement fix",
      "prompt": "Fix the issues found...",
      "_runtime": {
        "startedAt": 1700000061000
      }
    },
    {
      "prompt": "Run the tests"
    }
  ],
  "_runtime": {
    "currentIndex": 1,
    "executionState": "running"
  }
}
```

Note: `completedPrompts` is **not present** in the `_runtime` block. The per-prompt `_runtime.completedAt` timestamps are the sole record of completion.

---

## Backward Compatibility

Old working files on disk may have `completedPrompts[]` with no per-prompt `_runtime.completedAt`. On load via `restoreFromWorkingFile()`:

1. If no per-prompt `completedAt` is found, the code falls back to `currentIndex` as the completion boundary.
2. Prompts before `currentIndex` are added to `completedIds` and their `_runtime.completedAt` is written back (self-healing).
3. On the next `updateWorkingFile()`, the new format is persisted and `completedPrompts` disappears.

Old YAML/JSON workflow files that used `id:` are still valid — the `id` field is simply ignored by the schema (no error). Users who want the label to appear in the dashboard should rename it to `name`.
