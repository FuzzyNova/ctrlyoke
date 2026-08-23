# MCP Tool Call Display & Expand-Toggle Plan

**Status:** Implemented
**Priority:** P2

## Context

Fixing Codex's `exec`-wrapped MCP calls (`CliEventMapper.classifyMcpTool`'s
`mcp__<server>__<tool>` split, and `CodexToolBuilder` unwrapping
`tools.mcp__ctrlyoke__ctrlyoke_append_queue(...)` into a proper `MCP_TOOL_CALL`
INITIATED/COMPLETED pair instead of an opaque `exec(...)` tool call) surfaced a
second, pre-existing problem: once an MCP call is classified correctly, there is
nowhere in the UI to see its parameters at all. Before that fix, Codex's own MCP
calls were mis-rendered as a generic `exec`/bash tool call — which, accidentally,
is why the raw arguments were visible (in the wrong place, truncated, unsearchable).
Fixing the classification made that accidental visibility disappear.

This plan covers what's still open: rendering MCP parameters, replacing the small
`▼`/`▲` expand toggle with a bigger, discoverable control shared across bash
commands / generic tool calls / MCP tool calls, extending "find in output" to
search parameter text, and fixing MCP row height estimation so expand/collapse
doesn't break virtualized scroll position.

## Problems

1. **`McpToolCallOutput` renders no parameters.** (`src/ui/webview-react/components/output/ToolCallOutput.tsx:60-76`)
   It only renders a dot + `MCP: {server}.{tool}` label. `McpToolCallData.parameters`
   is populated correctly today (by every harness) but never reaches the DOM.
2. **The existing expand toggle is a plain `▼`/`▲` glyph and hard to notice.** Used
   in two places today: `BashOutput.tsx`'s full-command toggle (~line 246-265) and
   `GenericToolCallOutput`'s "show all parameters" toggle in `ToolCallOutput.tsx`
   (~line 259-278). Both are small, low-contrast, and give no indication of what
   they do beyond hover.
3. **Find-in-output never searches parameter text**, for either `TOOL_CALL` or
   `MCP_TOOL_CALL`. `getOutputRowSearchSegments` in `outputFind.ts` only indexes
   `toolLabel` (the name/server.tool) and `toolContent` (the result). A term that
   exists only inside a tool call's arguments — e.g. a queued step's prompt body —
   can't be found by search even after problem 1 is fixed. This is the other half
   of the original complaint ("I couldn't find where our own MCP was called").
4. **MCP row height estimation is a fixed one-liner.** `estimateStructuredTextHeight`'s
   `MCP_TOOL_CALL` case (`outputRows.ts` ~line 1312) always calls
   `estimateTerminalSummaryHeight` for a single summary line — there's no equivalent
   of `TOOL_CALL`'s `estimateToolCallStructuredEventHeight` path that accounts for
   an expanded params section. Adding an expand toggle without fixing this will
   make the virtualizer under-measure expanded MCP rows and jump/misjudge scroll
   position.

## Goals

1. Render MCP parameters in `McpToolCallOutput`, reusing the same
   `ToolCallExpansionState` / `buildToolCallRenderPlan` machinery
   `GenericToolCallOutput` already uses — no second parallel implementation.
2. Replace all three (two existing + one new) `▼`/`▲` toggles with one shared,
   bigger, more discoverable control.
3. Extend find-in-output segments to include parameter text for both `TOOL_CALL`
   and `MCP_TOOL_CALL`.
4. Give `MCP_TOOL_CALL` rows accurate virtualized height estimation.
5. Bring `markdownExport.ts`, `CliTerminalFormatter.ts`, and
   `HistoryCandidateExtractor.ts` up to the same level as the live view: today all
   three mirror the "label + result only" shape this plan fixes in the webview,
   so exported markdown, the CLI terminal fallback, and history-search all have
   the identical parameter-blindness problem for MCP calls (and, for
   `HistoryCandidateExtractor.ts`, for generic `TOOL_CALL` too — see section 7).

## Non-goals

- No bespoke MCP JSON viewer/formatter. Parameters render as the same raw text
  `GenericToolCallOutput` already shows for its params block today — still true
  even when `JSON.parse` fails and the value is Codex's raw exec-call text. A
  structured/collapsible JSON viewer is a separate, larger feature to consider
  later, not part of this plan.
- No change to which harnesses populate `McpToolCallData.parameters` — that part
  (`CliEventMapper`, `CodexToolBuilder`) is already shipped.
- No change to the bash output/error toggles, file-operation rendering, or
  `WebSearchOutput` — only the params/full-command visibility toggle and the two
  summary rows it's paired with (bash command, generic + MCP tool call params).
- No new truncation behavior for the params block itself — see section 3, this is
  a resolved design decision, not an open question.

## Design

### 1. Shared expand-toggle component

Extract one small shared component (suggested name: `ToolCallExpandToggle`,
alongside `ToolCallBlock.tsx` in `src/ui/webview-react/components/output/`) and
use it in three places instead of three ad hoc buttons:

- `BashOutput.tsx`'s full-command toggle.
- `GenericToolCallOutput`'s params toggle (`ToolCallOutput.tsx`).
- The new `McpToolCallOutput` params toggle (`ToolCallOutput.tsx`).

(`GenericToolCallOutput`'s output/error "[show more]" links and `BashOutput`'s
output/error links are a different, already-fine affordance — text links inline
with wrapped result content — and are out of scope here.)

Behavior:

- Icon: `codicon-chevron-right`, rotated 90° when expanded
  (`rotate-90 transition-transform duration-150`) — the same idiom already used
  by `DiffView.tsx`'s expand/collapse toggle and `OutputSectionHeader.tsx`'s
  collapse chevron, instead of a fourth distinct expand affordance in the
  codebase.
- Keep the current text color (`text-bash-expand-link`); make the hit target
  bigger by adding padding and letting it fill the header row's height rather
  than making the glyph itself taller — per explicit direction, growing the row
  taller than today is not the goal (it also helps keep the height-estimate
  change in section 4 smaller). Note this needs a small layout adjustment:
  `TOOL_CALL_LINE` (`outputStyles.ts`) is `items-baseline`, which doesn't give a
  flex child anything to `self-stretch` against. Achieving "fills available
  height, can be wider" cleanly likely means either sizing the button off the
  known line-height token (`toolCallLineHeight()` in `outputLineMetrics.ts`)
  rather than `self-stretch`, or reworking that one row's alignment — confirm
  visually before committing to an approach.
- Label: optional `label` prop ("Show input" / "Show parameters" / the existing
  "Show full command" wording for bash), rendered only when a `showLabel`
  boolean prop is true. The caller decides `showLabel` (see breakpoint below);
  the component stays a dumb, reusable primitive with no width awareness of its
  own.

### 2. "Show input" label breakpoint — reuse `outputContentWidth`, no new observer

`Header.tsx` itself doesn't call `useElementNarrow` directly (its own tiers come
from `useMediaQuery`/`useIsMobile`), but the closest existing analog to this exact
control shape — an icon button that hides its text label at narrow widths while
staying inside a dense horizontal group — is the same one already referenced for
this feature: `OutputSectionHeader.tsx`'s Undo/Redo buttons
(`{!isHeaderVeryNarrow && <span>...}`), fed by `OutputSection.tsx`'s
`useElementNarrow(400)` (`isHeaderVeryNarrow`, `useElementNarrow.ts`'s
`DEFAULT_THRESHOLD` tier). **Use `400` as the "Show input" label threshold**,
reusing that established value rather than picking a new one.

That said, don't reuse the *hook call* — `isHeaderVeryNarrow`'s `ResizeObserver`
watches one header element; a virtualized list can render hundreds of tool-call
rows and must not attach one `ResizeObserver` per row. `outputContentWidth` is
already computed once in `OutputSection.tsx` and threaded through
`useOutputRowsModel.ts` / `outputRows.ts` into every row build (it already drives
line-wrap/height math in `toolCallLayout.ts`). Reuse that single value with the
same `400` threshold instead: derive `showParamsLabel = outputContentWidth == null
|| outputContentWidth >= 400` once (either per row-build pass, or once in
`OutputSection.tsx` and passed down as a single boolean through `OutputPaneProps`),
the same way `DiffView` accepts `viewTypeProp` from its parent to skip its own
`ResizeObserver` when the parent already knows the answer.

### 3. `McpToolCallOutput` parameter rendering

Extend `McpToolCallOutputProps` (`ToolCallOutput.tsx`) with `parameters`,
`expansion`, `renderPlan`, `onExpansionChange` — mirroring
`GenericToolCallOutputProps`. `buildToolCallRenderPlan` and
`getGenericToolCallParamsText` (`toolCallLayout.ts`) are already generic over any
`{parameters?, result?}` shape (not `ToolCall`-specific), so no new layout code is
needed — reuse them directly. Render the params block the same way
`GenericToolCallOutput` does today (full text block under the header, behind the
toggle).

**Collapse/expand behavior — resolved, matches `GenericToolCallOutput` exactly,
no new truncation.** Confirmed against `toolCallLayout.ts`: today, collapsed
params render nothing at all (`buildHiddenSectionRenderPlan` — zero-height, no
preview), and expanding reveals the *entire* params text in one step (no nested
"show more" the way bash/tool-call **output/error** sections have). MCP reuses
this exact behavior unchanged — collapsed by default (chevron closed, fully
hidden), one click reveals everything, no second truncation step to click
through. This was raised as an open question in an earlier draft of this plan;
it's now a settled design decision, not something left open for
implementation to reinterpret.

### 4. Row plumbing (`outputRows.ts` / `OutputRow.tsx`)

- `outputRows.ts` ~line 1999-2054: widen both `visibleEvent.event.type ===
CLI_EVENT_TYPES.TOOL_CALL` checks (`toolCallExpansion` and `toolCallRenderPlan`)
  to also match `CLI_EVENT_TYPES.MCP_TOOL_CALL`, reading `.parameters`/`.result`
  the same way for `McpToolCallData` as for `ToolCall` (both interfaces already
  carry those two fields — no new type needed). `input.toolCallExpansionState` is
  keyed by `rowKey` alone, so both row kinds already share it safely with no
  collision risk.
- `OutputRow.tsx`'s `MCP_TOOL_CALL` case (~line 761): pass `parameters`,
  `expansion={row.toolCall?.expansion}`, `renderPlan={row.toolCall?.renderPlan}`,
  and `onExpansionChange={(section, expanded) =>
onToolCallExpansionChange?.(row.key, section, expanded)}` — identical wiring to
  the `TOOL_CALL` case immediately above it.

### 5. Height estimation (`outputRows.ts`)

- Replace the fixed `estimateTerminalSummaryHeight` call in the `MCP_TOOL_CALL`
  case (~line 1312) with the same estimation path `TOOL_CALL` uses:
  `estimateBaseStructuredEventHeight` (~line 1392) special-cases
  `row.event.type === CLI_EVENT_TYPES.TOOL_CALL && row.toolCall` to call
  `estimateToolCallStructuredEventHeight`; widen that condition to include
  `MCP_TOOL_CALL` too. This is required independent of the toggle redesign —
  without it, an expandable MCP row with no corresponding height estimate will
  visibly jump/misjudge scroll position the first time someone expands one.

### 6. Find-in-output coverage (`outputFind.ts`)

- Add a params segment (`getGenericToolCallParamsText(data.parameters)`) to both
  the `TOOL_CALL` (~line 237) and `MCP_TOOL_CALL` (~line 223) cases in
  `getOutputRowSearchSegments`. Today neither includes parameter text at all.
- Thread the new matches through to rendering: `OutputRow.tsx`'s `TOOL_CALL`/
  `MCP_TOOL_CALL` cases already call `getFieldMatches(...)` for
  `toolLabel`/`toolContent`; add a `paramsFindMatches`-style prop the same way and
  highlight the rendered params block in `GenericToolCallOutput`/`McpToolCallOutput`.

### 7. Export / terminal fallback / history-search parity

All three currently give `MCP_TOOL_CALL` strictly less than `TOOL_CALL` gets, in
the same "label + result only" shape the live view had before this plan. Bring
all three in line — each is a small, targeted addition mirroring what `TOOL_CALL`
already does in that same file, not new formatting logic:

- **`markdownExport.ts`** (~line 265-270): the `MCP_TOOL_CALL` case only emits
  `● MCP: {server}.{tool}`, never calling `formatToolCallForMarkdown` (which
  already takes `parameters` and formats a name+params summary via
  `extractKeyParameters`) or `formatToolResultForMarkdown` — both of which the
  adjacent `TOOL_CALL` case (~line 279-285) already calls. Change the
  `MCP_TOOL_CALL` case to call the same two helpers:
  `formatToolCallForMarkdown(\`MCP: ${data.server}.${data.tool}\`, data.parameters)`
  and, when `data.result` is present, `formatToolResultForMarkdown(data.result)` —
  identical shape to `TOOL_CALL`, just with the MCP label string.
- **`CliTerminalFormatter.ts`** (~line 419-427): the `MCP_TOOL_CALL` case prints
  only `⚙ server:tool`, never the params preview or result the `TOOL_CALL` case
  (~line 439-460) prints right below it (`JSON.stringify(data.parameters).slice(0,
80)` and a truncated `data.result.output`/`.error` line). Add the same two
  pieces to the MCP case.
- **`HistoryCandidateExtractor.ts`** (~line 179-196): the `MCP_TOOL_CALL` case
  indexes `data.server` and `data.tool` as search candidates but never
  `data.parameters`, while the adjacent `TOOL_CALL` case (~line 197-214) already
  does via `this.stringifyValue(data.parameters)`. Add the same
  `HISTORY_MATCH_FIELDS.CONTENT` candidate for `data.parameters` to the MCP case,
  reusing `this.stringifyValue` unchanged.

None of these three need the params-truncation, toggle, or height-estimation work
from sections 1-5 — they're plain-text/non-interactive surfaces (a markdown
export, a terminal print, a search index), so this is strictly "call the helper
this file already has for `TOOL_CALL`, with MCP's label/data" — no new
formatting decisions.

## Affected components

| Component | Planned role |
| --- | --- |
| `ToolCallOutput.tsx` | Add params rendering + expansion props to `McpToolCallOutput`; swap both toggles to the shared component |
| `BashOutput.tsx` | Swap command toggle to the shared component |
| New `ToolCallExpandToggle` (or similar, in `components/output/`) | Shared codicon-chevron + optional label toggle |
| `toolCallLayout.ts` | No new logic expected — `buildToolCallRenderPlan`/`getGenericToolCallParamsText` already generic; confirm during implementation |
| `outputRows.ts` | Widen `TOOL_CALL`-only expansion/render-plan attachment and height estimation to include `MCP_TOOL_CALL`; own `outputContentWidth` → `showParamsLabel` derivation |
| `OutputRow.tsx` | Wire `McpToolCallOutput`'s new props the same way `GenericToolCallOutput`'s are wired today |
| `outputFind.ts` | Add params segments to `TOOL_CALL`/`MCP_TOOL_CALL` search |
| `OutputSection.tsx` / `OutputPaneProps` | Only if `showParamsLabel` ends up computed once at this level rather than per-row-build |
| `markdownExport.ts` | Route `MCP_TOOL_CALL` through the same `formatToolCallForMarkdown`/`formatToolResultForMarkdown` helpers `TOOL_CALL` already uses |
| `CliTerminalFormatter.ts` | Add the same params-preview + result lines to `MCP_TOOL_CALL` that `TOOL_CALL` already prints |
| `HistoryCandidateExtractor.ts` | Add a `data.parameters` search candidate to `MCP_TOOL_CALL`, matching `TOOL_CALL` |

## Open questions

- Resolved in sections 1-2: `TOOL_CALL_LINE` now uses `items-center`, and the
  shared toggle uses a fixed `1.625em` height matching the relaxed header line
  height plus horizontal padding. This gives the button a larger hit target
  without making the row taller; the MCP toggle should reuse the same approach
  when section 3 is implemented.

## Acceptance criteria

- [x] MCP tool call rows show a discoverable input/parameters toggle and render the
  same raw-text content `GenericToolCallOutput` already shows for generic tool
  call parameters, collapsed by default and revealing everything in one click
  (no nested "show more" step).
- [x] Bash command, generic tool call, and MCP tool call expand toggles all use one
  shared codicon-chevron component instead of three separate `▼`/`▲` buttons, and
  the "Show input" label appears once the row is at least 400px wide (matching
  `OutputSectionHeader.tsx`'s existing `isHeaderVeryNarrow` threshold).
- [x] Expanding/collapsing generic or MCP tool call parameters does not cause
  virtualized scroll-position jumps.
- [x] "Find in output" matches text that exists only inside a tool call's (generic or
  MCP) parameters.
- [x] Exported markdown, the CLI terminal fallback, and history-search results all
  include MCP tool call parameters, matching what `TOOL_CALL` already includes in
  each of those three surfaces.
