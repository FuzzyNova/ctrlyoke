# Migration Plan: `name` Field + Per-Prompt Completion Tracking

## Summary

Two interrelated schema changes:

1. **Rename `id` → `name`**: Make the user-facing label field human-readable (free text, no
   regex). Remove all machine-key semantics from this field.

2. **Per-prompt completion tracking**: Move completion tracking from
   `WorkingFileRuntime.completedPrompts[]` (workflow-level derived index) to
   `prompt._runtime.completedAt` (the already-existing per-prompt timestamp that is the true
   source of truth). Simplify `reloadAndMergeQueue`, `restoreFromWorkingFile`, and the MCP
   server's dedup logic.

These two changes are coupled: `id` was needed as a machine key for the
`"{id}:{hash}"` tracking ID format. Once completion is tracked per-prompt via `completedAt`,
that key format becomes unnecessary, so `id` has no structural role left and can be repurposed
as the human-readable `name` field.

---

## Background / Context

### Current `id` usage (everything it does today)

| Location                                              | What it does                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `prompt-schema.json`                                  | `"pattern": "^[a-zA-Z0-9-_]+$"`, `"maxLength": 50` — machine-key constraint       |
| `PromptIdentity.ts:markPromptCompleted`               | Builds tracking string `"${id}:${hash}"` or `"${hash}"`                           |
| `PromptIdentity.ts:isPromptCompleted`                 | Checks `"{id}:{hash}"` and hash fallback against `completedIds` Set               |
| `PromptQueue.ts:restoreFromWorkingFile`               | Loads `completedPrompts[]` → `completedIds` Set                                   |
| `PromptQueue.ts:updateWorkingFile`                    | Writes `completedIds` → `completedPrompts[]` on disk                              |
| `PromptQueue.ts:reloadAndMergeQueue`                  | Calls `isPromptCompleted()`, also builds `currentPromptHashes` using `prompt.id`  |
| `PromptQueue.ts:mergePromptsFromDisk`                 | `memoryPromptMap.set(prompt.id, prompt)` for identity lookup                      |
| `PromptQueue.ts:updateWorkingFile`                    | Auto-assigns `id = hash` for prompts without an explicit id                       |
| `mcp-server.ts:validatePrompts`                       | Checks 2 & 3: pending-queue dedup by ID and hash                                  |
| `mcp-server.ts:getPromptStatus`                       | `runtime.completedPrompts.includes(String(index))`                                |
| `mcp-server.ts:append_queue tool`                     | `new Set(runtime.completedPrompts)` → passes to `validatePrompts`                 |
| `FlightPathManager.ts:executeEphemeralPrompt`         | Sanitizes `promptName` → kebab-case → `promptId = "${sanitized}-${date}-${time}"` |
| `FlightPathManager.ts:generateWorkflowNameFromPrompt` | Uses `promptName` to name the working file                                        |
| `editorStore.ts:enterEditMode`                        | `promptName: promptData.id ?? ""` — loads `id` into the name input                |
| `editorStore.ts:getPromptProperties`                  | `result.id = promptName.trim()` — saves name input back to `id`                   |

### Why `completedPrompts[]` is redundant

`updateWorkingFile()` already writes each prompt's `_runtime` (including `completedAt`) to the
working file at `prompts[i]._runtime.completedAt`. The `completedPrompts[]` array at the
workflow level is a derived index of that data — useful for O(1) lookup but not the source of
truth.

### Why pending-queue dedup (MCP checks 2 & 3) should be removed

Checks 2 & 3 in `mcp-server.ts:validatePrompts` reject a prompt if its content or `id` matches
something already in the pending queue. This prevents users from queueing the same prompt
multiple times (e.g., "run the tests" ten times in a row). The `maxQueueSize` limit (default 100) is sufficient protection against infinite loops. These checks should be removed; only
Check 1 (already completed) should remain.

---

## Target State

### New schema for `promptItem`

```json
"promptItem": {
  "type": "object",
  "allOf": [
    { "$ref": "#/definitions/executionProperties" },
    {
      "properties": {
        "name": {
          "type": "string",
          "description": "Optional human-readable display label shown in the FlightPath dashboard. If omitted, the dashboard shows a truncated preview of the prompt text.",
          "maxLength": 100
        },
        "prompt": { ... },
        "_runtime": { "$ref": "#/definitions/promptRuntimeMetadata" }
      },
      "required": ["prompt"]
    }
  ]
}
```

No `pattern` constraint. Spaces, punctuation, and uppercase are all allowed.

### New `runtimeMetadata` (workflow-level)

Remove `completedPrompts` from the required fields and from the schema:

```json
"runtimeMetadata": {
  "type": "object",
  "properties": {
    "currentIndex": { "type": "number" },
    "executionState": { "type": "string", "enum": [...] }
  },
  "required": ["currentIndex", "executionState"],
  "additionalProperties": false
}
```

`completedPrompts` is **no longer written** to the working file. On backward-compat load of old
files that still have it, it is ignored (the per-prompt `_runtime.completedAt` is the source of
truth; old files without per-prompt `_runtime` fall back to `currentIndex` — see migration
path below).

### Completion tracking — new rule

A prompt is considered completed if:

```
prompt._runtime?.completedAt !== undefined
```

That's it. No hash. No ID tracking string. No Set lookup for this purpose. The in-memory
`completedIds` Set is repurposed as a **fast-lookup cache** built from `completedAt` during
load, but is no longer persisted to disk.

### Workflow file example (after migration)

```json
{
  "originalFile": "...",
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

---

## File-by-File Changes

### 1. `schemas/prompt-schema.json`

**Change A** — Rename `id` → `name` in `promptItem`:

```diff
- "id": {
-   "type": "string",
-   "description": "Optional unique identifier...",
-   "pattern": "^[a-zA-Z0-9-_]+$",
-   "maxLength": 50
- },
+ "name": {
+   "type": "string",
+   "description": "Optional human-readable display label shown in the FlightPath dashboard. If omitted, the dashboard shows a truncated preview of the prompt text.",
+   "maxLength": 100
+ },
```

**Change B** — Remove `completedPrompts` from `runtimeMetadata`:

```diff
  "runtimeMetadata": {
    "type": "object",
    "properties": {
      "currentIndex": { "type": "number", ... },
-     "completedPrompts": {
-       "type": "array",
-       "items": { "type": "string" },
-       "description": "Array of completed prompt IDs and hashes"
-     },
      "executionState": { "type": "string", "enum": [...] }
    },
-   "required": ["currentIndex", "completedPrompts", "executionState"],
+   "required": ["currentIndex", "executionState"],
    "additionalProperties": false
  }
```

After editing the JSON schema, run:

```bash
npm run generate-schema
```

This regenerates `schemas/prompt-schema.yaml` from the JSON source.

---

### 2. `src/types/FlightPathTypes.ts`

**Change A** — Rename `id` → `name` in `PromptItem`:

```diff
  export interface PromptItem extends ExecutionProperties {
-   id?: string; // Optional unique identifier for tracking across queue reloads
+   name?: string; // Optional human-readable display label
    prompt: string;
    sessionId?: string | number;
    _runtime?: PromptRuntimeMetadata;
  }
```

**Change B** — Remove `completedPrompts` from `WorkingFileRuntime`:

```diff
  export interface WorkingFileRuntime {
    currentIndex: number;
-   completedPrompts: string[]; // IDs and hashes of completed prompts
    executionState: ExecutionState;
  }
```

**Change C** — Remove `completedIds` from `QueueState` (or keep as internal cache — see
PromptQueue changes):

```diff
  export interface QueueState {
    currentIndex: number;
    status: ExecutionState;
    prompts: PromptItem[];
    results: PromptResult[];
    stopped: boolean;
-   completedIds: Set<string>; // Track completed prompt IDs and hashes
    totalExecutionTime: number;
    ...
  }
```

> **Note**: `completedIds` as an internal `Set` inside `PromptQueue` can be kept as a private
> implementation detail (not on the exported `QueueState` type) if it is still used as a
> fast-lookup cache. See `PromptQueue.ts` section below for the decision.

---

### 3. `src/utils/PromptIdentity.ts`

**Delete `isPromptCompleted()`** — this function implements the `"{id}:{hash}"` tracking logic
that goes away entirely.

**Keep `hashPromptContent()`** — still used in `PromptQueue.ts:mergePromptsFromDisk` for
identity matching when merging disk vs. memory prompts.

**Keep `shouldInjectExtensionInstructions()`** — unchanged, no relation to `id`.

**Remove the `id` reference** inside `isPromptCompleted` (the whole function is deleted).

After this change, update the import in every file that imports `isPromptCompleted`:

- `src/flightpath/PromptQueue.ts` — remove import, update callers
- `src/mcp-server.ts` — remove import, update callers

---

### 4. `src/flightpath/PromptQueue.ts`

This file has the most changes. Go through each relevant function:

#### `restoreFromWorkingFile()` (line ~194)

Old:

```typescript
const completedIds = new Set<string>(runtime?.completedPrompts || []);
```

New — build `completedIds` from per-prompt `_runtime.completedAt`:

```typescript
// Build completedIds from per-prompt _runtime.completedAt
// This is the new source of truth (completedPrompts array is ignored)
const completedIds = new Set<string>(
  workingFile.prompts
    .filter((p) => p._runtime?.completedAt !== undefined)
    .map((_, i) => String(i)) // Use index as key (position-based identity)
);
```

> **Design note**: The `completedIds` Set is kept in-memory as a fast-lookup cache during
> execution. Its keys are now **prompt indices** (as strings: `"0"`, `"1"`, `"2"`) rather than
> `"{id}:{hash}"` tracking strings. This is simpler and avoids content/name matching entirely.

Also update the results-rebuilding loop:

Old:

```typescript
if (isPromptCompleted(prompt, this.state.completedIds)) {
  status = STEP_STATUS.COMPLETED;
}
```

New:

```typescript
if (prompt._runtime?.completedAt !== undefined) {
  status = STEP_STATUS.COMPLETED;
}
```

#### `markPromptCompleted()` (line ~796)

Old:

```typescript
markPromptCompleted(prompt: PromptItem): void {
  const hash = hashPromptContent(prompt.prompt);
  const hasExplicitId = prompt.id && prompt.id !== hash;
  const trackingId = hasExplicitId ? `${prompt.id}:${hash}` : hash;
  this.state.completedIds.add(trackingId);
}
```

New — add `completedAt` to the prompt's `_runtime` and update in-memory index by position:

```typescript
markPromptCompleted(index: number): void {
  // Set completedAt on the prompt's own _runtime (source of truth)
  const prompt = this.state.prompts[index];
  if (prompt) {
    prompt._runtime = {
      ...prompt._runtime,
      completedAt: Date.now(),
      // preserve startedAt and other fields
    } as PromptRuntimeMetadata;
  }
  // Update in-memory fast-lookup index (key = prompt index as string)
  this.state.completedIds.add(String(index));
}
```

Update the call site in `completeCurrentAndMoveNext()`:

Old:

```typescript
this.markPromptCompleted(currentPrompt);
```

New:

```typescript
this.markPromptCompleted(this.state.currentIndex);
```

#### `updateWorkingFile()` (line ~1433)

Old:

```typescript
workingFile._runtime = {
  currentIndex: this.state.currentIndex,
  completedPrompts: Array.from(this.state.completedIds),
  executionState: this.state.status,
};
```

New — remove `completedPrompts`:

```typescript
workingFile._runtime = {
  currentIndex: this.state.currentIndex,
  executionState: this.state.status,
};
```

The per-prompt `_runtime.completedAt` is already written via the prompts array (line ~1404),
so no additional change needed there.

Also remove the auto-id-assignment block (line ~1404-1414):

Old:

```typescript
workingFile.prompts = this.state.prompts.map((prompt) => {
  if (!prompt.id) {
    return {
      ...prompt,
      id: hashPromptContent(prompt.prompt),
    };
  }
  return prompt;
});
```

New — just spread as-is (no auto-id needed):

```typescript
workingFile.prompts = this.state.prompts.map((prompt) => ({ ...prompt }));
```

#### `reloadAndMergeQueue()` (line ~818)

Old:

```typescript
// Build set of hashes for prompts currently in queue
for (const existingPrompt of this.state.prompts) {
  const hash = hashPromptContent(existingPrompt.prompt);
  currentPromptHashes.add(hash);
  if (existingPrompt.id) {
    currentPromptHashes.add(existingPrompt.id);
  }
}

// Find truly new prompts (not completed, not already in queue)
for (const prompt of reloadedPrompts) {
  if (isPromptCompleted(prompt, this.state.completedIds)) {
    continue;
  }
  const hash = hashPromptContent(prompt.prompt);
  if (
    currentPromptHashes.has(hash) ||
    (prompt.id && currentPromptHashes.has(prompt.id))
  ) {
    continue;
  }
  newPrompts.push(prompt);
}
```

New — completion check uses `completedAt`, not `completedIds`:

```typescript
// Build set of hashes for prompts currently in queue (still needed for pending-queue dedup)
for (const existingPrompt of this.state.prompts) {
  const hash = hashPromptContent(existingPrompt.prompt);
  currentPromptHashes.add(hash);
}

// Find truly new prompts
for (const prompt of reloadedPrompts) {
  // Skip if already completed (per-prompt _runtime is authoritative)
  if (prompt._runtime?.completedAt !== undefined) {
    continue;
  }
  // Skip if already in current pending queue (by content hash)
  const hash = hashPromptContent(prompt.prompt);
  if (currentPromptHashes.has(hash)) {
    continue;
  }
  newPrompts.push(prompt);
}
```

Note: `id` references in the hash-building loop are removed. Content-hash dedup of the pending
queue is still kept here (unlike MCP server, where it's removed) because this is a file-reload
scenario where the same prompt file is re-read, not a user intentionally adding duplicates.

#### `mergePromptsFromDisk()` (line ~948)

Old:

```typescript
const memoryPromptMap = new Map<string, PromptItem>();
for (const prompt of this.state.prompts) {
  const hash = hashPromptContent(prompt.prompt);
  memoryPromptMap.set(hash, prompt);
  if (prompt.id) {
    memoryPromptMap.set(prompt.id, prompt);
  }
}

const existsInMemory =
  memoryPromptMap.has(hash) ||
  (diskPrompt.id && memoryPromptMap.has(diskPrompt.id));
```

New — remove `prompt.id` references:

```typescript
const memoryPromptMap = new Map<string, PromptItem>();
for (const prompt of this.state.prompts) {
  const hash = hashPromptContent(prompt.prompt);
  memoryPromptMap.set(hash, prompt);
}

const existsInMemory = memoryPromptMap.has(hash);
```

#### `createWorkingFile()` (line ~1200)

Remove `completedPrompts: []` from the initial `_runtime`:

Old:

```typescript
_runtime: {
  currentIndex: 0,
  completedPrompts: [],
  executionState: EXECUTION_STATES.IDLE,
},
```

New:

```typescript
_runtime: {
  currentIndex: 0,
  executionState: EXECUTION_STATES.IDLE,
},
```

---

### 5. `src/mcp-server.ts`

#### `validatePrompts()` (line ~510)

**Remove checks 2, 3, and 4** (pending-queue dedup). Keep only check 1 (already completed).

Old:

```typescript
validatePrompts(newPrompts, existingPrompts, completedIds) {
  const seenHashes = new Set<string>();
  const seenExplicitIds = new Set<string>();

  // Build tracking sets from existing queue
  for (const existingPrompt of existingPrompts) {
    const hash = hashPromptContent(existingPrompt.prompt);
    const hasExplicitId = existingPrompt.id && existingPrompt.id !== hash;
    if (hasExplicitId) seenExplicitIds.add(existingPrompt.id!);
    if (!hasExplicitId) seenHashes.add(hash);
  }

  for (const newPrompt of newPrompts) {
    const hash = hashPromptContent(newPrompt.prompt);
    const hasExplicitId = newPrompt.id && newPrompt.id !== hash;

    // Check 1: Already completed
    if (isPromptCompleted(newPrompt, completedIds)) { ... continue; }

    // Check 2: Duplicate explicit ID in existing queue
    if (hasExplicitId && seenExplicitIds.has(newPrompt.id!)) { ... continue; }

    // Check 3: Duplicate content (no explicit ID)
    if (!hasExplicitId && seenHashes.has(hash)) { ... continue; }

    // Check 4: Duplicate within this append batch
    ...
  }
}
```

New — only check 1 remains. Signature changes: `completedIds` is no longer a `Set<string>` of
tracking strings; instead pass `existingPrompts` and check `_runtime.completedAt` directly:

```typescript
validatePrompts(
  newPrompts: PromptItem[],
  existingPrompts: PromptItem[]
): Array<{ prompt: PromptItem; accepted: boolean; reason?: string }> {
  const results = [];

  for (const newPrompt of newPrompts) {
    // Only check: already completed (per-prompt _runtime is authoritative)
    const alreadyCompleted = existingPrompts.some(
      (p) =>
        p._runtime?.completedAt !== undefined &&
        p.prompt === newPrompt.prompt // or content-hash match
    );

    if (alreadyCompleted) {
      results.push({ prompt: newPrompt, accepted: false, reason: "Prompt already completed" });
      continue;
    }

    results.push({ prompt: newPrompt, accepted: true });
  }

  return results;
}
```

Update the call site to remove the `completedIds` argument:

Old:

```typescript
const validationResults = this.validatePrompts(
  prompts,
  queueData.prompts || [],
  new Set(runtime.completedPrompts || [])
);
```

New:

```typescript
const validationResults = this.validatePrompts(
  prompts,
  queueData.prompts || []
);
```

#### `getPromptStatus()` (line ~650)

Old:

```typescript
private getPromptStatus(index: number, runtime: WorkingFileRuntime): string {
  if (runtime.completedPrompts.includes(String(index))) {
    return "completed";
  }
  if (index === runtime.currentIndex) return "running";
  if (index < runtime.currentIndex) return "completed";
  return "pending";
}
```

New — pass prompts array to check `_runtime.completedAt`:

```typescript
private getPromptStatus(index: number, runtime: WorkingFileRuntime, prompts: PromptItem[]): string {
  if (prompts[index]?._runtime?.completedAt !== undefined) {
    return "completed";
  }
  if (index === runtime.currentIndex) return "running";
  if (index < runtime.currentIndex) return "completed"; // fallback
  return "pending";
}
```

Update caller to pass the prompts array.

Remove the import of `isPromptCompleted` from `mcp-server.ts` (keep `hashPromptContent` if
still used for content-hash comparison in `validatePrompts`).

---

### 6. `src/flightpath/FlightPathManager.ts`

#### `executeEphemeralPrompt()` (line ~1645)

The `promptName` argument is used for:

1. Naming the workflow working file
2. Setting `promptItem.id` (→ becomes `promptItem.name`)
3. Building a timestamped `promptId` to avoid dedup collisions

After this migration, `promptItem.name` is just stored as-is (no sanitization needed for the
field). The working file naming still sanitizes to kebab-case (that's a filename constraint, not
a schema constraint).

Old:

```typescript
let promptId: string;
if (promptName && promptName.trim().length > 0) {
  const sanitizedName = promptName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  promptId = `${sanitizedName}-${dateStr}-${timeStr}`;
} else {
  promptId = `ephemeral-${Date.now()}`;
}

const promptItem: PromptItem = {
  prompt: text,
  id: promptId,
  ...this.buildPromptItemProperties(properties),
};
```

New:

```typescript
const promptItem: PromptItem = {
  prompt: text,
  // Store name as-is (human-readable, no sanitization)
  ...(promptName?.trim() ? { name: promptName.trim() } : {}),
  ...this.buildPromptItemProperties(properties),
};
```

The `generateWorkflowNameFromPrompt()` function still sanitizes to kebab-case for the filename
(that's fine — it's producing a filesystem name, not a schema value). Keep it unchanged.

#### `generateWorkflowNameFromPrompt()` (line ~1615)

No change needed. It already handles `promptName` as input and produces a kebab-case filename.
The `promptName` parameter now comes from the `name` field instead of `id`, but the function
logic is identical.

---

### 7. `src/ui/webview-react/store/editorStore.ts`

#### `enterEditMode()` (line ~277)

Old:

```typescript
promptName: promptData.id ?? "",
```

New:

```typescript
promptName: promptData.name ?? "",
```

#### `getPromptProperties()` (line ~517)

Old:

```typescript
if (promptName.trim()) {
  result.id = promptName.trim();
}
```

New:

```typescript
if (promptName.trim()) {
  result.name = promptName.trim();
}
```

No other changes in `editorStore.ts`. The `promptName` state variable name stays as-is
(internal UI state naming doesn't need to match the schema field name).

---

### 8. `src/ui/webview-react/components/prompts/PromptItem.tsx`

Currently `id` is received but immediately discarded (`id: _id`, `void _id`). After migration,
receive `name` instead and display it as the primary label when present:

Old props interface:

```typescript
interface PromptItemProps {
  text: string;
  index: number;
  status: StepStatus;
  id?: string;   // received but not used for display
  ...
}
```

New:

```typescript
interface PromptItemProps {
  text: string;
  index: number;
  status: StepStatus;
  name?: string;  // displayed when present
  ...
}
```

Update the display line (currently line ~123):

Old:

```tsx
<span className="font-medium">{index + 1}.</span> {truncate(text, 60)}
```

New:

```tsx
<span className="font-medium">{index + 1}.</span>{" "}
{name ? name : truncate(text, 60)}
```

---

### 9. `src/ui/webview-react/components/prompts/PromptsPanel.tsx` (or wherever `PromptItem` is rendered)

Find where `PromptItem` is rendered and update prop name from `id` to `name`:

Old:

```tsx
<PromptItem id={prompt.id} text={prompt.prompt} ... />
```

New:

```tsx
<PromptItem name={prompt.name} text={prompt.prompt} ... />
```

---

### 10. `src/types/WebviewMessageTypes.ts`

If `PromptItem` is defined here as well (it is, at line ~205), rename `id` → `name`:

Old:

```typescript
export interface PromptItem {
  id?: string;
  prompt: string;
  ...
}
```

New:

```typescript
export interface PromptItem {
  name?: string;
  prompt: string;
  ...
}
```

---

### 11. `src/ui/webview-react/utils/prompt.ts`

There is a local `PromptItem` interface here too (line ~75). Rename `id` → `name` to match.

---

### 12. `src/ui/webview-react/store/workflowStore.ts`

Check the `PromptItem` type used in the workflow store's prompts array. If it has an `id`
field, rename to `name`.

---

### 13. `src/ui/FlightPathWebviewProvider.ts`

The `handleUpdatePrompt()` at line ~1151 destructures `{ index, text, properties }` — no `id`
involved here, no change.

The `handleExecutePrompt()` at line ~1127 passes `promptName` to `executeEphemeralPrompt()` —
no change needed, the function signature stays the same (`promptName` is just the string the
user typed).

---

### 14. `src/test/promptIdentity.test.ts`

The entire test file tests `isPromptCompleted()` which is being deleted. Delete or replace this
test file:

- Delete all `isPromptCompleted` tests (they test logic that no longer exists)
- Keep the `hashPromptContent` tests (the function still exists)
- Add new tests for the completion-by-`completedAt` path if needed (but this is simpler to test
  — just check that `prompt._runtime?.completedAt !== undefined`)

---

### 15. `src/test/promptQueue.test.ts`

Update the test at line ~308 ("should update working file to clear completedPrompts"):

Old:

```typescript
assert.strictEqual(
  workingFile._runtime!.completedPrompts.length,
  0,
  "Working file should have empty completedPrompts array after restart"
);
```

New — check that `completedPrompts` is not present (or check per-prompt `completedAt`):

```typescript
assert.strictEqual(
  workingFile._runtime!.completedPrompts,
  undefined,
  "Working file should not have completedPrompts array"
);
```

---

## Backward Compatibility

Existing working files on disk have `completedPrompts[]` but no per-prompt `_runtime.completedAt`.

**Strategy**: On `restoreFromWorkingFile()`, after migration:

```typescript
// New: per-prompt completedAt is the source of truth
const hasPerPromptTracking = workingFile.prompts.some(
  (p) => p._runtime?.completedAt !== undefined
);

if (!hasPerPromptTracking && runtime?.completedPrompts?.length) {
  // Old format: fall back to currentIndex as the completion boundary
  // Prompts before currentIndex are considered completed
  Log.info(
    "Old working file format detected: using currentIndex for completion boundary"
  );
  // Mark prompts 0..currentIndex-1 as completed using position-based completedIds
  for (let i = 0; i < (runtime.currentIndex || 0); i++) {
    completedIds.add(String(i));
    // Optionally write completedAt back to prompts for self-healing
    if (workingFile.prompts[i]) {
      workingFile.prompts[i]._runtime = {
        ...workingFile.prompts[i]._runtime,
        startedAt: workingFile.startedAt,
        completedAt: workingFile.startedAt + 1, // sentinel value
      } as PromptRuntimeMetadata;
    }
  }
} else {
  // New format: build completedIds from per-prompt completedAt
  workingFile.prompts.forEach((p, i) => {
    if (p._runtime?.completedAt !== undefined) {
      completedIds.add(String(i));
    }
  });
}
```

On the next `updateWorkingFile()`, the new format is written and the old `completedPrompts`
field naturally disappears.

---

## `PromptIdentity.ts` — What Remains

After removing `isPromptCompleted()`:

```typescript
// src/utils/PromptIdentity.ts

// KEEP: still used for content-hash matching in mergePromptsFromDisk
export function hashPromptContent(promptText: string): string { ... }

// KEEP: still used for dynamic queue extension instruction injection
export function shouldInjectExtensionInstructions(...): boolean { ... }

// DELETE: replaced by prompt._runtime?.completedAt !== undefined
export function isPromptCompleted(...): boolean { ... }
```

---

## `QueueState.completedIds` — Final Decision

Keep `completedIds: Set<string>` in `QueueState` but change its key format from
`"{id}:{hash}"` tracking strings to **prompt index strings** (`"0"`, `"1"`, `"2"`).

Rationale:

- The in-memory Set is still useful for O(1) lookup in `mergePromptsFromDisk` and during
  execution
- Position-based keys are simpler and unambiguous
- It's still an implementation detail; the source of truth remains `prompt._runtime.completedAt`

---

## Dashboard Display (EditorSection name input)

The `EditorSection.tsx` prompt name input currently:

- Shows in "new prompt" mode only (not edit mode)
- Binds to `promptName` in `editorStore`
- Is hidden in edit mode

After migration, also show the name input in **edit mode** (since `name` is now a useful label
rather than a machine key, users will want to set it on existing prompts too):

```tsx
{
  /* Show name input in both new and edit modes */
}
<input
  type="text"
  className="prompt-name-input ..."
  placeholder="Prompt name (optional)"
  value={promptName}
  onChange={(e) => setPromptName(e.target.value)}
/>;
```

Remove the `{!isEditMode && (` guard. This is a UX improvement enabled by the rename.

Also update the `handleUpdate` callback in `PromptEditor.tsx` — the `UPDATE_PROMPT` message
should include `name` in the properties when updating an existing prompt. Check
`FlightPathWebviewProvider.handleUpdatePrompt()` to ensure `name` is passed through to
`updatePromptInQueue()`.

---

## Summary of All Changed Files

| File                                                       | Change type                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/prompt-schema.json`                               | `id` → `name`, remove `completedPrompts` from `runtimeMetadata`                                                                          |
| `schemas/prompt-schema.yaml`                               | Auto-generated — run `npm run generate-schema`                                                                                           |
| `src/types/FlightPathTypes.ts`                             | `id` → `name` in `PromptItem`, remove `completedPrompts` from `WorkingFileRuntime`                                                       |
| `src/types/WebviewMessageTypes.ts`                         | `id` → `name` in `PromptItem`                                                                                                            |
| `src/utils/PromptIdentity.ts`                              | Delete `isPromptCompleted()`                                                                                                             |
| `src/flightpath/PromptQueue.ts`                            | `restoreFromWorkingFile`, `markPromptCompleted`, `updateWorkingFile`, `reloadAndMergeQueue`, `mergePromptsFromDisk`, `createWorkingFile` |
| `src/flightpath/FlightPathManager.ts`                      | `executeEphemeralPrompt`: `id` → `name`, remove sanitized ID generation                                                                  |
| `src/mcp-server.ts`                                        | `validatePrompts`: remove checks 2-4, remove `completedIds` param; `getPromptStatus`: use `completedAt`                                  |
| `src/ui/FlightPathWebviewProvider.ts`                      | No change (passes `promptName` string through unchanged)                                                                                 |
| `src/ui/webview-react/store/editorStore.ts`                | `promptData.id` → `promptData.name`, `result.id` → `result.name`                                                                         |
| `src/ui/webview-react/store/workflowStore.ts`              | `id` → `name` in local `PromptItem` type                                                                                                 |
| `src/ui/webview-react/utils/prompt.ts`                     | `id` → `name` in local `PromptItem` interface                                                                                            |
| `src/ui/webview-react/components/prompts/PromptItem.tsx`   | `id` prop → `name` prop, display `name` as primary label                                                                                 |
| `src/ui/webview-react/components/prompts/PromptsPanel.tsx` | `id={prompt.id}` → `name={prompt.name}`                                                                                                  |
| `src/ui/webview-react/components/layout/EditorSection.tsx` | Show name input in edit mode too                                                                                                         |
| `src/test/promptIdentity.test.ts`                          | Delete `isPromptCompleted` tests, keep `hashPromptContent` tests                                                                         |
| `src/test/promptQueue.test.ts`                             | Update `completedPrompts` assertions                                                                                                     |

**Estimated scope**: ~300 lines changed across 16 files. No new files needed.

---

## Execution Order

1. `FlightPathTypes.ts` — types first (compiler will catch all downstream usages)
2. `prompt-schema.json` + `npm run generate-schema`
3. `PromptIdentity.ts` — remove `isPromptCompleted`
4. `PromptQueue.ts` — largest change, fix all compiler errors
5. `mcp-server.ts`
6. `FlightPathManager.ts`
7. `WebviewMessageTypes.ts` + `workflowStore.ts` + `prompt.ts`
8. `editorStore.ts`
9. `PromptItem.tsx` + `PromptsPanel.tsx` + `EditorSection.tsx`
10. `promptIdentity.test.ts` + `promptQueue.test.ts`
11. Run `npm run compile` — fix any remaining type errors
12. Run `npm run build:webview`
13. Run `npm test`
