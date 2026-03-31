# MCP Tool Enhancements Plan

**Date:** 2026-03-22
**Context:** The two existing MCP tools (`flightpath_queue_status`, `flightpath_append_queue`) give AI harnesses enough to extend queues, but lack the properties needed for genuinely adaptive, context-aware workflows. This plan covers four enhancements: a `capabilities.json` IPC file + `flightpath_capabilities` tool, a new `flightpath_read_output` tool, `resumeSession` on append, and per-prompt harness/model overrides with real validation.

---

## Enhancement 1: `capabilities.json` + `flightpath_capabilities` Tool

### Motivation

Which harnesses are installed and which models are available varies per machine and per user — one developer has only Claude Code installed, another has all seven harnesses. OpenCode model lists are user-configured. Copilot model lists come from VS Code's Language Model API at runtime. There is no static list that is correct for all users.

The extension already computes both of these data structures:

- `harnessStatus: Record<HarnessId, { available: boolean; status: string }>` — built during harness initialization checks
- `modelOptions: Record<HarnessId, Array<{ value: string; label: string }>>` — built by `WebviewSettingsSync.buildModelOptions()` from `ModelRegistry`, sent to the webview on init and on `MODEL_OPTIONS_UPDATE`

The MCP server needs this same information to (a) answer AI queries about what's valid and (b) validate harness/model on append. Since the MCP server is a standalone stdio process with no VS Code API access, the solution is the same pattern FlightPath already uses everywhere: **write the state to a file, read it from the other process**.

### The `capabilities.json` file

**Location:** `.flightpath/capabilities.json`

**Written by:** The extension (via `WebviewSettingsSync` or a new `CapabilitiesWriter` utility) whenever harness status or model options change. This already happens at two points:

1. After harness initialization (`sendHarnessStatusUpdate`)
2. After model registry loads (`sendModelOptionsUpdate`)

Both points write to the webview — the same trigger should also write `capabilities.json`.

**Format:**

```json
{
  "generatedAt": 1711234567890,
  "harnesses": [
    {
      "id": "claude-cli",
      "displayName": "Claude Code",
      "available": true,
      "models": [
        { "value": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6" },
        { "value": "claude-opus-4-6", "label": "Claude Opus 4.6" },
        { "value": "claude-haiku-4-5", "label": "Claude Haiku 4.5" }
      ]
    },
    {
      "id": "copilot-cli",
      "displayName": "Copilot CLI",
      "available": false,
      "models": []
    },
    {
      "id": "opencode-cli",
      "displayName": "OpenCode",
      "available": true,
      "models": [
        {
          "value": "anthropic/claude-sonnet-4-6",
          "label": "Anthropic / Claude Sonnet 4.6"
        }
      ]
    }
  ]
}
```

**Staleness:** The file is regenerated on extension startup and whenever harness status or model options change. The MCP server reads it fresh on each tool call (no caching). The `generatedAt` timestamp is included for diagnostics but not used for cache invalidation — freshness is guaranteed by the extension rewriting on change.

**Missing file:** If `capabilities.json` does not exist (no session has initialized it yet), `flightpath_capabilities` returns an error. `flightpath_append_queue` falls back to no-validation mode (accepts any harness/model string, same behavior as today).

### `flightpath_capabilities` Tool

```json
{
  "name": "flightpath_capabilities",
  "description": "Get available harnesses and their supported models on this machine. Call this before appending prompts with harness or model overrides to ensure you use valid values. Returns only harnesses that are installed and detected as available.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

**Response:**

```json
{
  "generatedAt": 1711234567890,
  "harnesses": [
    {
      "id": "claude-cli",
      "displayName": "Claude Code",
      "available": true,
      "models": ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]
    }
  ]
}
```

The response filters to only available harnesses. Unavailable ones are omitted — there is no reason to offer them to the AI for selection.

### Harness/Model Validation on Append

When `harness` or `model` is provided on `flightpath_append_queue`:

1. Read `capabilities.json` (best-effort — skip validation if file absent)
2. If `harness` provided: check it exists in the available harness list. If not, error with the list of available harness IDs.
3. If `model` provided alongside `harness`: check model is in that harness's model list. If not, error with the valid model values for that harness.
4. If `model` provided without `harness`: check against the workflow's default harness (from the working file). If workflow has no harness set, skip model validation (can't know which harness applies).

### Implementation

**New file or method in `src/ui/WebviewSettingsSync.ts` (or thin `CapabilitiesWriter.ts` utility):**

- `writeCapabilities(workspaceRoot, harnessStatus, modelOptions)` — serializes to `capabilities.json`
- Called from `sendHarnessStatusUpdate()` and `sendModelOptionsUpdate()` after the existing webview postMessage

**`src/mcp-server.ts`:**

- Add `flightpath_capabilities` to `ListToolsRequestSchema` handler
- Add `handleCapabilities()` method — reads and parses `.flightpath/capabilities.json`, filters to available harnesses, returns the result
- Add `readCapabilities()` helper — reads the file, returns parsed object or null if absent
- Use `readCapabilities()` in `handleQueueAppend` for validation before inserting prompts

**`src/flightpath/QueueOperations.ts`:**

- No changes needed — capabilities validation lives in the MCP server (file-based IPC) and the LM Tool (can call VS Code APIs directly for the in-process path)

**`src/extension.ts` LM Tools:**

- Register `flightpath_capabilities` as a third LM Tool
- Its `invoke` reads directly from `WorkflowOrchestrator`/`WebviewSettingsSync` in-process (no file needed for the VS Code Chat path — it has direct access to the data)

---

## Enhancement 2: `flightpath_read_output` (New Tool)

### Motivation

`flightpath_queue_status` returns prompt text and status but not what the AI _produced_. `PromptRuntimeMetadata.responseText` is already stored per-prompt (the same field `priorContext` uses for static injection). The difference: `priorContext` is fixed at authoring time. `flightpath_read_output` lets an AI dynamically inspect prior results at runtime before deciding what to add next.

This enables genuinely adaptive patterns:

- Read step 2's output → decide whether to add a "fix" prompt or a "proceed" prompt
- Inspect an analysis result → generate targeted follow-up prompts based on actual findings
- Build conditional branches without pre-planning every path

### Schema

```json
{
  "name": "flightpath_read_output",
  "description": "Read the AI response text from completed prompts in the current workflow. Use this to inspect prior results before deciding what to add next.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "indices": {
        "type": "array",
        "items": { "type": "number" },
        "description": "Zero-based indices of prompts to read. Omit or pass empty array to read all prompts."
      }
    }
  }
}
```

`indices` is optional. Omitted or empty means all prompts — avoids forcing the caller to enumerate 0..N-1 for a full read.

### Response

```json
{
  "outputs": [
    {
      "index": 2,
      "prompt": "Analyze the architecture...",
      "status": "completed",
      "responseText": "I found 3 main issues: ..."
    },
    {
      "index": 3,
      "prompt": "Fix the auth layer",
      "status": "pending",
      "responseText": null
    }
  ]
}
```

Non-completed prompts return `responseText: null` — not an error, the caller checks `status`.

### Implementation

**`src/mcp-server.ts`:**

- Add `flightpath_read_output` to `ListToolsRequestSchema` handler
- Add `handleReadOutput(args)` — reads the working file, extracts `prompts[i]._runtime?.responseText` for requested indices
- No file lock needed (read-only)

**`src/flightpath/QueueOperations.ts`:**

- Add `ReadOutputRequest` and `ReadOutputResponse` interfaces
- Add `readQueueOutput(queue, indices)` function — pulls `responseText` from prompt `_runtime` metadata
- Wire into `src/extension.ts` LM Tools as a fourth registered tool

---

## Enhancement 3: `resumeSession` on `flightpath_append_queue`

### Motivation

Without `resumeSession`, every MCP-appended prompt starts a fresh AI session. This is almost never what you want when an AI is dynamically extending its own workflow — it loses all conversation context. Highest-impact, lowest-complexity change.

This enhancement also removes the `reason` parameter from `flightpath_append_queue`. It is currently accepted but logged and discarded — never stored in the queue or surfaced anywhere. Requiring the AI to generate a sentence of justification wastes tokens with no benefit. `source` is retained (short, useful for debugging — identifies which caller added prompts to the queue).

### Schema Change (per-prompt item)

```json
{
  "prompt": { "type": "string" },
  "resumeSession": {
    "type": "boolean",
    "description": "Continue a prior prompt's conversation session. Must be true to enable session resumption. Default: false (new session)."
  },
  "sessionId": {
    "type": "number",
    "description": "1-based prompt number whose session to resume. Requires resumeSession: true. Omit to resume the immediately preceding prompt's session. Use flightpath_queue_status to identify prompt indices. Example: sessionId: 3 resumes the conversation started at prompt 3, regardless of how many prompts have run since."
  }
}
```

**Session resumption behaviour:**

| `resumeSession`   | `sessionId` | Result                                               |
| ----------------- | ----------- | ---------------------------------------------------- |
| `false` / omitted | —           | New session                                          |
| `true`            | omitted     | Resume session from the immediately preceding prompt |
| `true`            | `3`         | Resume session from prompt 3's conversation          |

`sessionId` without `resumeSession: true` is ignored — explicitness is required. Only the numeric form is exposed here; string session IDs (actual CLI GUIDs) are internal implementation details the AI should never construct.

### Implementation

**`src/flightpath/QueueOperations.ts`:**

- Add `resumeSession?: boolean` and `sessionId?: number` to the per-prompt item type in `AppendPromptsRequest`
- Remove `reason?: string` from `AppendPromptsRequest`
- Thread both fields through into the `PromptItem` mapping

**`src/mcp-server.ts`:**

- Add `resumeSession` and `sessionId` to `items.properties` in the `flightpath_append_queue` inputSchema
- Remove `reason` from the `flightpath_append_queue` inputSchema
- No logic changes — both fields land on the `PromptItem` and the harness resolves them at execution time

**`src/extension.ts` LM Tools:**

- Add `resumeSession` and `sessionId` to the per-prompt object type in the append tool `invoke`

---

## Enhancement 4: Per-Prompt `harness` and `model` Overrides

### Motivation

`model` is already in `AppendPromptsRequest` and the MCP schema but `harness` is not. Exposing both lets an AI route specific steps to different execution frameworks or models — e.g., appending a research step to run under a different harness, or switching to a faster model for a lightweight formatting step.

### The "harness-model combo string" Proposal — Rejected

The proposal was to expose a combined `"harness-model"` enum so the schema itself prevents mismatches. This was rejected because:

1. **Availability is per-machine, not static.** One user has only `claude-cli` installed; another has all seven. A hardcoded enum of all harnesses is wrong for most users.
2. **Model lists are dynamic and user-configured.** OpenCode models depend on what the user has set up. Copilot models come from VS Code's LM API. There is no static list that is correct.
3. **A combo string loses independent expressiveness.** Users should be able to set `model` alone (change model, keep workflow harness) or `harness` alone. A combined string forces both to be specified together.

The capabilities approach (Enhancement 1) solves the underlying problem properly: the AI calls `flightpath_capabilities` first to get the real valid values for this machine, then appends with confidence.

### Schema Change (per-prompt item)

```json
{
  "prompt": { "type": "string" },
  "model": {
    "type": "string",
    "description": "Model override for this prompt. Must be compatible with the target harness. Call flightpath_capabilities to get valid model values per harness."
  },
  "harness": {
    "type": "string",
    "description": "Harness override for this prompt. If omitted, uses the workflow default. Call flightpath_capabilities to get installed harness IDs and their available models."
  },
  "resumeSession": { "type": "boolean" }
}
```

Note: `harness` is a free string here (no `enum`) because the valid set is machine-dependent and provided at runtime by `flightpath_capabilities`. Validation happens at append time using `capabilities.json`.

### `queue_status` Metadata Enhancement

Add workflow-level `harness` and `model` to metadata so the AI knows the baseline before making per-prompt decisions:

```json
{
  "metadata": {
    "workflowName": "...",
    "harness": "claude-cli",
    "model": "claude-sonnet-4-6",
    "currentIndex": 2,
    ...
  }
}
```

Sourced from `queueData.harness` / `queueData.model` (top-level `WorkingFile` fields). Returns `null` if not set in the workflow file (workflow uses extension default settings, which the MCP server cannot read directly).

### Implementation

**`src/flightpath/QueueOperations.ts`:**

- Add `harness?: string` to the per-prompt item type in `AppendPromptsRequest`
- Add `harness?: string | null` and `model?: string | null` (workflow-level) to `QueueStatusResponse.metadata`
- Thread `harness` through into the `PromptItem` mapping

**`src/mcp-server.ts`:**

- Add `harness` field to the append tool schema (free string, no enum)
- Add `harness` and `model` to the status metadata block in `handleQueueStatus` from `queueData`

**`src/extension.ts` LM Tools:**

- Add `harness` to per-prompt object in append tool invoke

---

## Files Changed Summary

| File                                | Changes                                                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/WebviewSettingsSync.ts`     | Write `capabilities.json` when harness status or model options change                                                                                                                                                      |
| `src/mcp-server.ts`                 | New `flightpath_capabilities` tool + handler; new `flightpath_read_output` tool + handler; add `resumeSession`/`harness` to append schema + validation against capabilities.json; add `harness`/`model` to status metadata |
| `src/flightpath/QueueOperations.ts` | New `ReadOutputRequest`/`ReadOutputResponse` interfaces + `readQueueOutput()`; add `resumeSession`/`harness` to `AppendPromptsRequest`; add `harness`/`model` to `QueueStatusResponse.metadata`                            |
| `src/extension.ts`                  | Register `flightpath_capabilities` + `flightpath_read_output` LM Tools; thread `resumeSession`/`harness` through append LM Tool                                                                                            |
| `src/utils/ConfigurationUtils.ts`   | Add `CAPABILITIES_FILE = "capabilities.json"` to `PATH_CONSTANTS`                                                                                                                                                          |

---

## Implementation Order

1. **`capabilities.json` writer** — foundation everything else builds on; unblocks validation
2. **`flightpath_capabilities` tool** — expose the file via MCP + LM Tool
3. **`resumeSession`** — smallest functional change, highest ROI
4. **`harness`/`model` on append + validation + queue_status metadata** — depends on capabilities.json being written
5. **`flightpath_read_output`** — new tool, most surface area, implement last

---

## Status

**Complete.** All five enhancements are implemented.

---

## Follow-Up: Replace `allowDynamicExtension` with `mcpServers`

Now that MCP is the mechanism for dynamic queue extension, `allowDynamicExtension` is replaced by a richer `mcpServers` property that lets users inject any MCP server (not just FlightPath) into individual prompts. Simultaneously:

- The `finalPrompt` loop gate (`if (!allowDynamicExtension) wrap up`) is removed entirely — the loop becomes purely behavioral (`queueSizeAfter > queueSizeBefore`)
- The `enableDynamicQueue` VS Code setting is renamed to `mcpServers` (array instead of boolean)

See `docs/research/MCP_SERVERS_PROPERTY_PLAN.md` for the full plan.
