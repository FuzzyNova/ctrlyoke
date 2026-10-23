# Collapsible Subagent Groups in the Output Pane

**Status:** Not started. Split out of `SUBAGENT_OUTPUT_ATTRIBUTION_PLAN.md`
(implemented), which shipped the first cut: subagent rows indented and labelled
under the spawn card.

## Goal

Render a subagent's rows as a collapsible group under its spawn card instead
of indented rows in time order:

- One group per `(parentToolCallId, agentId)` group key
  (`src/utils/SubagentAttribution.ts`), one sub-group per child for a spawn
  whose `subagentSpawn.children` lists several (antigravity-cli).
- Interleaved siblings stay in separate groups; grandchildren form a tree.
- Collapsed automatically once `subagentSpawn.state` leaves running; a user's
  explicit expand wins.
- Rows that arrive before their spawn row still render, then regroup.
- Find (`outputFind.ts`) expands a collapsed group, and its ancestors, when a
  match lands inside it.

## Why it was split out

`src/ui/webview-react/utils/outputRows.ts` builds a flat list of rows that the
virtualizer indexes directly, and has no group-header row kind. Two attempts
stopped at the same point: nesting needs a new virtual row kind, a
group-aware flattening pass ahead of virtualization (with height estimation
for only the visible rows), collapse state in the output store, and find
navigation that can reveal hidden rows. That is a dashboard architecture
change, not a subagent feature, and it deserves its own design pass.

## Open questions

- Reorder rows into groups, or keep time order and only fold contiguous runs?
  Reordering changes what the minimap and timestamps mean.
- Where collapse state lives so it survives reconnects and the hosted
  dashboard (see `.github/instructions/webview-react-store.instructions.md`).
