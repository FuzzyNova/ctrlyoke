# Subagent group label is shown for rows that render nothing

- **Found:** 2026-10-24 by Claude (claude-cli) while reviewing subagent output display
- **Area:** `src/ui/webview-react/components/output/OutputRow.tsx`, `src/ui/webview-react/utils/outputRows.ts`
- **Severity:** low

## Symptom

A subagent's output can show a bare "Subagent: <description>" label with nothing
under it. The label belongs to an event in the subagent's group that renders no
content of its own. The label also "uses up" the group's label: `showLabel` is
true only on a group's first row, so the next row that has content shows no
label.

Before this was filed, the subagents' `WebFetch` calls produced exactly this: a
web search row with an empty query and a bare label. That source is fixed
(`webfetch`/`web_fetch` are now generic tool calls), but any other event that
renders nothing still does it.

## Steps to Reproduce

1. Run a subagent whose child activity includes an event that renders nothing,
   such as a `webSearch` event with an empty `query` or a `toolCall` with an
   empty `name`.
2. The output shows the "Subagent: …" label with no row content beneath it.

## Root Cause

Whether an event is drawn is decided in two places that don't share a rule.

- `OutputRow`'s structured-event renderer returns `null` for some events: a
  `WEB_SEARCH` with no `query`, or a `TOOL_CALL` with no `name`.
- `buildOutputRows` (`outputRows.ts`) still creates a row for those events and
  gives it subagent metadata through `resolveSubagentMetadata`, including
  `showLabel`. `OutputRow` then wraps the empty content in the subagent group
  wrapper, which draws the label regardless.

The row-height estimate also counts `SUBAGENT_LABEL_HEIGHT` and content height
for a row that draws nothing, so virtualization starts off with a wrong height
there.

## Suggested Fix

Decide visibility once, when rows are built:

1. Extract a single predicate, e.g. `isRenderableStructuredEvent(event)`, that
   holds the "renders nothing" rules `OutputRow` uses now. Put it next to the row
   builders so both layers import it.
2. In `buildOutputRows`, skip events the predicate rejects _before_
   `resolveSubagentMetadata` runs. `previousSubagentGroup` then advances only on
   drawn rows, and the label lands on the first row that has content.
3. Have `OutputRow` use the same predicate for its early `return null`, so the
   two can't drift apart again.

Don't just hide the label when the content is `null` inside `OutputRow`. That
would leave an empty row in the list with a wrong height estimate, and the next
row would still have lost its label.
