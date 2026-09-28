# ctrlyoke MCP Tool-Call Views — purpose-built rows for our own MCP tools

> **Status:** Not implemented. Follows the 2026-09-28 removal of `CoordinationActivityRow`
> (see the addendum in
> [`EXECUTION_ROOT_COORDINATION_PLAN.md`](../implemented/EXECUTION_ROOT_COORDINATION_PLAN.md)),
> which left the generic MCP tool-call row as the only place a step's coordination activity
> appears in the output timeline.

## Problem

Every call an agent makes to ctrlyoke's own MCP server renders through the generic
`McpToolCallOutput` (`src/ui/webview-react/components/output/ToolCallOutput.tsx`): a
`MCP: ctrlyoke.append_step` label, the raw parameters as JSON, and the raw result as a JSON
string. We own both ends of these tools — the input schemas (`MCP_TOOL_DEFINITIONS`,
`src/utils/McpToolDefinitions.ts`) and the result payloads (built in `src/mcp-server.ts`) — so
the dashboard can show what actually happened instead of a JSON dump:

- `append_step` tells the user the queue changed, but they have to read escaped JSON to learn
  _which_ steps landed _where_.
- `post_note` is a human-language message wrapped in `{"text": "...\n..."}` with escaped
  newlines, so markdown in the note is unreadable.
- `workflow_status` / `global_status` return large status objects that are almost always
  collapsed and never skimmed.
- `claim_paths` can partially fail (`denied[]` with owners) and that failure is buried inside a
  `success`-coloured row.

Generic third-party MCP tools keep the generic row. This plan is only for the 13 tools we
define.

## Current pipeline (what a custom view has to fit into)

- **Classification is parse-time and name-based; rendering is event-type-based.**
  `CliEventMapper.classifyMcpTool` (`src/core/harness/shared/CliEventMapper.ts:173`) turns
  `mcp__ctrlyoke__x` / `ctrlyoke(x)` / `ctrlyoke.x` into an `MCP_TOOL_CALL` event carrying
  `McpToolCallData { server, tool, parameters?, result? }`. `OutputRow` then switches on
  `event.type` (`OutputRow.tsx:930`, `case CLI_EVENT_TYPES.MCP_TOOL_CALL`). Nothing branches on
  tool name in the renderer today; existing specialisations (bash, file edits, web search,
  ask-user-question) are all separate event types chosen at parse time.
- **Every ctrlyoke tool returns one text block holding `JSON.stringify(...)`**, errors as
  `Error: <msg>` with `isError: true`. No tool uses `structuredContent`.
- **Find and height estimation are keyed to the generic text.**
  `getOutputRowSearchSegments` (`outputFind.ts:250`) emits `toolLabel` / `params` /
  `toolContent` segments from the generic label, params text, and result text. Height goes
  through `estimateToolCallStructuredEventHeight` (`outputRows.ts:1656`) and
  `buildToolCallRenderPlan` (`utils/toolCallLayout.ts`). A custom view that renders different
  text from what those functions measure and search will break find highlighting and scroll
  anchoring.
- **Constants already exist to single-source against:** `MCP_SERVER_IDS.CTRLYOKE`
  (`DashboardConstants.ts:3963`); the `MCP_*_TOOL_NAME` constants and the
  `MCP_WORKFLOW_MUTATION_TOOL_NAMES` / `MCP_COORDINATION_TOOL_NAMES` groups
  (`McpToolDefinitions.ts:607`, `:617`); per-tool labels in `CTRLYOKE_USER_TOOLS`
  (`components/shared/McpServersEditor.tsx`); and the coordination formatters in
  `utils/coordinationPresentation.ts`.
- **Harness coverage is uneven:**
  - Claude, Qwen, Codex (after unwrapping `tools.mcp__ctrlyoke__x(`) and Antigravity produce
    `MCP_TOOL_CALL`.
  - Copilot produces `MCP_TOOL_CALL` but sets **no `parameters`**.
  - OpenCode has no MCP detection at all, so its calls arrive as a generic `TOOL_CALL`.
  - In `mcpMode: skill` the agent runs `node "<mcp-server.js>" --tool <name> --args '<json>'`
    (`src/templates/skills/ctrlyoke-mcp-tools/SKILL.md:13`), which arrives as a `BASH_COMMAND`.

## Design

### 1. A registry, not a switch

Add `src/ui/webview-react/components/output/ctrlyoke-tools/` with one view module per tool
family and a typed registry:

```ts
type CtrlYokeToolViewKey = (typeof MCP_TOOL_NAMES)[number]; // derived from McpToolDefinitions

interface CtrlYokeToolView<TParams, TResult> {
  parseParams(raw: unknown): TParams | undefined; // undefined → fall back
  parseResult(text: string): TResult | undefined; // undefined → fall back
  summary(params: TParams | undefined, result: TResult | undefined): string; // header label
  searchText(params, result): OutputRowSearchSegment[]; // single source for find
  estimateHeight(params, result, width, fontSize): number; // single source for virtualizer
  Body: React.FC<{ params; result; findDecorations; ... }>;
}

export const CTRLYOKE_TOOL_VIEWS: Partial<
  Record<CtrlYokeToolViewKey, CtrlYokeToolView<any, any>>
>;
```

`OutputRow`'s `MCP_TOOL_CALL` case asks `resolveCtrlYokeToolView(server, tool)` first and falls
back to `McpToolCallOutput` when there is no view, when parsing fails, or when the result is an
error (errors keep the existing red error section). `outputFind.ts` and
`estimateToolCallStructuredEventHeight` call the **same** resolver and use the view's
`searchText` / `estimateHeight`. That keeps find, height, and rendering in one module per tool
rather than three parallel switches. Views are keyed off the `MCP_*_TOOL_NAME` constants, never
string literals. Registry membership is a typed `Record`, not dynamic dispatch, per the
nominal-typing rule.

Result parsing is defensive by construction: payloads come from agents' tool results (and, in
the history viewer, from older runs), so each `parseResult` validates shape and returns
`undefined` on any mismatch rather than throwing. A "Raw" toggle on every custom view shows the
generic params/result, so nothing is ever hidden behind the pretty view.

### 2. Server identity

Match the server with `MCP_SERVER_IDS.CTRLYOKE` and add a constant for the `ctrlyoke-commit`
server id (currently a literal at `src/git/CommitMessageGenerator.ts:364`) so
`submit_commit_message` can be matched too. Users can rename a server in `mcpServers`, so match
on the server id ctrlyoke itself attaches, not on a display name.

### 3. Per-tool views

| Tool                    | Header summary                                | Body                                                                                                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append_step`           | "Appended 3 steps at #5 (next)"               | Table: position · name · harness/model · prompt preview (first line, expandable). Parallel batches render as a grouped block with a `failFast` badge. Uses `insertIndex` / `insertedEndIndex` / `placement` from the result so indices are the _actual_ landing positions, not the requested `position`. |
| `edit_step`             | "Edited step #4 — prompt, model"              | Field/before→after list for changed properties; `clearProperties` shown as struck-through. Prompt changes as a compact diff using the existing diff renderer.                                                                                                                                            |
| `remove_step`           | "Removed step #4 'Fix CLI exit code'"         | One line; the name is resolved from params/result where available.                                                                                                                                                                                                                                       |
| `reorder_steps`         | "Reordered 6 steps"                           | Before→after index list.                                                                                                                                                                                                                                                                                 |
| `workflow_status`       | "Step 3/8 · running · claude-cli"             | Progress bar plus a compact step table (status icon, name, harness). `schemaWarnings` rendered as warnings.                                                                                                                                                                                              |
| `global_status`         | "4 workflows (2 running)"                     | Workflow list with state chips; `truncated` / `omittedCount` shown.                                                                                                                                                                                                                                      |
| `read_output`           | "Read output of steps #1, #2"                 | Per-step collapsible `responseText` rendered through `MarkdownText`; cursor/tail shown as a subtle footer.                                                                                                                                                                                               |
| `list_harnesses`        | "6 harnesses (4 available)"                   | Harness chips with availability; models collapsed.                                                                                                                                                                                                                                                       |
| `post_note`             | "Note → all" / "Note → reviewer"              | Note `text` rendered as markdown via `MarkdownText`, marked untrusted (`data-untrusted-content`, `COORDINATION_UNTRUSTED_LABEL`) exactly as the settings panel does.                                                                                                                                     |
| `read_notes`            | "Read 5 notes"                                | Entry list reusing `coordinationParticipantAttribution` / `coordinationEntrySummary`, note bodies as markdown, untrusted-marked.                                                                                                                                                                         |
| `claim_paths`           | "Claimed 6 paths" / "Claimed 4, **2 denied**" | Granted paths as a file list (clickable via `openContextReference`); denied paths with their owner. A denial gives the row a warning status rather than success.                                                                                                                                         |
| `release_paths`         | "Released 6 paths"                            | File list; `notHeld` shown muted.                                                                                                                                                                                                                                                                        |
| `submit_commit_message` | First line of the message                     | Full message in a monospace block.                                                                                                                                                                                                                                                                       |

The shared `scope` object that every coordination tool returns is **not** rendered per call. It
is the same board state the settings panel shows, and repeating it on every row is exactly the
noise `CoordinationActivityRow` was removed for.

### 4. Parameters-less and non-MCP arrivals

- **Copilot (no `parameters`):** every view must render from the result alone. The result
  payloads already carry what the summaries need (`append_step` returns indices and counts, not
  step content), so for Copilot the `append_step` table degrades to "3 steps at #5–#7" plus the
  names read back from the result. Add the appended step names/indices to the `append_step`
  result so this works without params, which also benefits agents reading the result.
- **OpenCode:** add ctrlyoke MCP detection to `OpenCodeEventMapper` (which today maps unknown
  tools to a generic `TOOL_CALL`). First confirm from a captured OpenCode log how it names MCP
  tools, then add an OpenCode-side mapping rather than loosening the shared classifier.
- **Skill mode:** recognise `mcp-server.js --tool <name> --args <json>` bash commands at parse
  time (in the shared bash-command mapper, so every harness benefits) and emit a synthetic
  `MCP_TOOL_CALL` with `server: ctrlyoke`, parsed args as `parameters`, and stdout as the
  result. The row can carry a small "via skill" badge. This is the only path that gives
  skill-mode users the same views.

### 5. Out of scope

- A dedicated event type per ctrlyoke tool. Keeping them `MCP_TOOL_CALL` means history files,
  exports, the terminal renderer, and the CLI stay unchanged; only the webview view layer learns
  about them.
- Adding `structuredContent` to the MCP results. That is worth doing separately for agent
  consumers, but the views parse the text JSON that already exists and every recorded run
  already carries.
- CLI (`src/cli/`) terminal formatting of these calls. It is a natural follow-up that reuses the
  same `summary()` functions if they live in a platform-neutral util rather than the component
  folder.

## Implementation order

1. Registry, resolver, fallback plumbing, and the "Raw" toggle, wired through `OutputRow`,
   `outputFind`, and height estimation. Ship with **`post_note`** and **`append_step`**, the two
   highest-value views. Add tests that find-highlighting and `estimateOutputRowHeight` agree with
   the rendered text for both.
2. `claim_paths` / `release_paths` / `read_notes`, with the warning status for denials.
3. `workflow_status`, `global_status`, `read_output`, `list_harnesses`, `edit_step`,
   `remove_step`, `reorder_steps`, `submit_commit_message`.
4. OpenCode MCP detection.
5. Skill-mode bash → synthetic `MCP_TOOL_CALL` mapping.

## Tests

- Per view: parse success, parse failure → generic fallback, error result → generic error
  section, Copilot-shaped event with no `parameters`.
- `outputFind` segments for each view match the rendered text (find highlights land).
- `estimateOutputRowHeight` for each view is within tolerance of measured height at two widths,
  following the existing tool-call estimate tests in `src/ui/webview-react/test/utils/`.
- Untrusted note text is rendered as markdown but never as raw HTML, and it keeps the
  untrusted marker.
- Parser tests for the OpenCode and skill-mode mappings in `src/test/**`.
