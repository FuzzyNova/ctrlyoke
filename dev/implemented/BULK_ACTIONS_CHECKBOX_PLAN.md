# Bulk Actions Checkbox Redesign Plan

## Status: FlightPath as a bulk target — DONE

Before this redesign, `McpManagerSection`'s bulk bar could only Save All/Delete All
to/from external harness configs (`EXPORT_TARGET_IDS`: VS Code, Claude, Copilot,
Codex, OpenCode, Qwen). "FlightPath" (the registry itself, `.flightpath/mcp/servers.json`
or `~/.flightpath/mcp/servers.json`) is now also a target, in both scopes:

- **Save All → FlightPath (scope X)**: writes every managed server's config into
  scope X's registry via `addOrUpdateServer`. This is how you "promote" servers
  from one scope's registry to the other (e.g. test in workspace, then bulk-save
  to FlightPath User to make them available everywhere).
- **Delete All ← FlightPath (scope X)**: bulk-removes (via `deleteServer`) every
  managed server that currently has a registry location in scope X. This is the
  "prune the workspace registry after promoting to user" half of the workflow.

Implemented in `McpManagerSection.tsx`: `getMcpTargetsForScope`, `handleSaveAll`,
`handleDeleteAllRequest`, `handleConfirmDeleteTarget` (all branch on
`SPECIAL_TARGET_IDS.FLIGHTPATH`). `getExportTargetLabel`/`getExportTargetDescription`
already had FlightPath cases from the per-server location dropdowns, so no new
label/description work was needed.

---

## Problem Statement

`BulkLocationActionsBar` (shared by `AgentSkillsManagerSection` and
`McpManagerSection`) is an all-or-nothing control: one action/scope/target
selector and a single button that applies to **every** managed item in the list.
This has two problems:

1. **No partial operations.** You can't export/delete/promote just a subset —
   it's everything or nothing.
2. **Doesn't generalize to "Set Default".** Skills (`defaults.skills`) and MCP
   servers (`defaults.mcpServers`) both support *multiple* defaults, so "make
   exactly these N items the defaults" is a natural bulk operation — but it
   doesn't fit the save/delete-to-a-location shape (no scope/target needed).

## Goal

Replace the single dropdown-bar with a standard **checkbox-selection** pattern:

- A checkbox on every row (FileRow for agents/skills, server row for MCP).
- A header "select all" checkbox (tri-state: all / none / some).
- A bulk action bar that operates **only on checked rows**, with three possible
  actions: **Save (to)**, **Delete (from)**, **Set Default**.
- "Set Default" is hidden entirely when viewing **agents** (single-valued
  `defaults.agent` — bulk-selecting multiple agents and "setting default" is
  ambiguous, so the existing per-row default toggle remains the only way).
- When "Set Default" is selected, the scope/target location dropdowns are
  hidden — defaults are written to `activeScope` directly, no target needed.

---

## Affected Components

| File | Change |
| --- | --- |
| `src/ui/webview-react/components/shared/BulkLocationActionsBar.tsx` | Replaced by new `BulkSelectionActionsBar.tsx` (or heavily reworked in place) |
| `src/ui/webview-react/components/settings/AgentSkillsManagerSection.tsx` | Add selection state, row checkboxes, header checkbox, wire new bar |
| `src/ui/webview-react/components/settings/McpManagerSection.tsx` | Same |

---

## Design

### Selection state

Each section owns a `selectedIds: Set<string>` (keyed by `file.name` for
agents/skills, `server.id` for MCP).

- **Default**: all current items selected (preserves the existing one-click
  "apply to everything" behavior — users opt *out* by unchecking rather than
  opt *in*).
- When the underlying list changes (items added/removed via discovery, save,
  delete, etc.), reconcile: drop ids no longer present, and add newly-appeared
  ids as selected (keep the "default = everything" property stable rather than
  surprising the user with a partially-stale selection).
- Header checkbox state derived from `selectedIds.size` vs `items.length`:
  `0` → unchecked, `length` → checked, otherwise → indeterminate
  (`<input ref>` + `el.indeterminate = true`, since HTML checkboxes have no
  `indeterminate` attribute).

### Row UI

Add a checkbox as the first element of:
- `FileRow`'s row 1 (before the title), in `AgentSkillsManagerSection.tsx`.
- The MCP server row's title row, in `McpManagerSection.tsx`.

Existing per-row controls (Save/Delete/Edit/Set-default dropdowns) are
**unchanged** — they remain the "just this one item" path. Checkboxes +
the new bulk bar are the "batch" path.

### New `BulkSelectionActionsBar`

```ts
type BulkAction = "save" | "delete" | "setDefault";

interface BulkSelectionActionsBarProps {
  totalCount: number;
  selectedCount: number;
  selectAllState: "all" | "none" | "some";
  onToggleSelectAll: () => void;

  // which actions are valid for this section/type — agents omit "setDefault"
  availableActions: BulkAction[];

  // save/delete location controls (same shape as today's BulkLocationActionsBar)
  getTargetsForScope: (scope: SettingWriteScope) => AnyTargetId[];
  getTargetLabel: (id: AnyTargetId) => string;
  getTargetDescription: (id: AnyTargetId, scope: SettingWriteScope) => string;
  defaultTargetId: AnyTargetId;

  onSave: (id: AnyTargetId, scope: SettingWriteScope) => void;
  onDelete: (id: AnyTargetId, scope: SettingWriteScope) => void;
  onSetDefault: () => void;
}
```

Layout:

```
[ ☑ Select all (N selected) ]   [Save ▾] [to:] [Workspace ▾] [Claude ▾] [Save]
                                  ^ action        ^ scope       ^ target  ^ submit
```

When `action === "setDefault"`:

```
[ ☑ Select all (N selected) ]   [Set Default ▾]                         [Set as Default]
```

— scope/target selects are hidden (or replaced with static text like
`"→ defaults (Workspace)"` showing `activeScope`, for clarity).

Submit button disabled when `selectedCount === 0`.

### "Set Default" semantics

- **Skills**: replace `defaults.skills` with the `name`s of every *checked*
  skill row.
- **MCP**: replace `defaults.mcpServers` with the configs of every *checked*
  managed server (reuse `upsertDefaultServer`/existing default-array helpers).
- For both: any existing default entries that don't correspond to a
  currently-*visible* managed item are preserved as-is (don't silently drop
  defaults for items not in the current list/scope — only the visible/checked
  set is reconciled). This avoids surprising data loss if defaults reference
  items from another scope not currently shown.
- **Agents**: `availableActions` excludes `"setDefault"` — the existing
  per-row "Set Default" toggle (single-valued `defaults.agent`) is unchanged.

### Save All / Delete All semantics (updated)

Same operations as today, but scoped to `items.filter(i => selectedIds.has(key(i)))`:

- AgentSkills "Save (to)" → `syncAll(selectedFiles, targetId, activeType, scope)`.
- AgentSkills "Delete (from)" → **not** the existing `deleteAll` flow.
  Current plumbing only supports deleting an entire target directory for a
  given file type, so partial delete must use one of these implementations:
  - call the existing per-file delete path once per selected file, or
  - add a new explicit bulk-selected delete message/handler for agents/skills.
  Do not reuse `deleteAll` for partial selection; that would over-delete.
- MCP "Save (to)" → `exportToHarness(selectedConfigs, targetId, scope)`, or for
  FlightPath target, `addOrUpdateServer` per selected server.
- MCP "Delete (from)" → existing delete-all flow (harness or FlightPath),
  restricted to selected server ids.

---

## Implementation Steps

1. Build `BulkSelectionActionsBar` (new shared component), covering the
   save/delete layout (mostly ported from `BulkLocationActionsBar`) plus the
   select-all header and the `setDefault` action/layout branch.
2. `AgentSkillsManagerSection.tsx`:
   - Add `selectedIds` state + reconciliation effect.
   - Add row checkboxes to `FileRow`.
   - Wire `availableActions` = `activeType === "agent" ? ["save", "delete"] : ["save", "delete", "setDefault"]`.
   - Implement bulk `setDefault` handler (skills only — replace `defaults.skills`
     with checked skill names).
   - Update `handleSaveAll` to filter by `selectedIds`.
   - Replace the current bulk delete implementation for partial selection:
     either loop over selected files via the existing per-file delete path, or
     add a dedicated selected-delete message/handler. Do not route through the
     current `deleteAll(harnessId, fileType, scope)` plumbing.
3. `McpManagerSection.tsx`:
   - Same selection state + row checkboxes.
   - `availableActions = ["save", "delete", "setDefault"]` always (MCP has no
     agent-equivalent single-default case).
   - Implement bulk `setDefault` handler — replace `defaults.mcpServers` with
     checked servers' configs.
   - Update `handleSaveAll`/`handleDeleteAllRequest` (including the FlightPath
     branches added above) to filter by `selectedIds`.
4. Add/update UI tests:
   - `BulkSelectionActionsBar` tri-state select-all behavior.
   - Agent/skill selected-only save dispatch.
   - Agent/skill selected-only delete dispatch.
   - Skills show bulk `Set Default`; agents do not.
   - MCP selected-only save/delete dispatch, including FlightPath target.
   - MCP/skills bulk `Set Default` preserves existing default entries for items
     outside the currently visible managed list.
5. Remove `BulkLocationActionsBar.tsx` once both sections are migrated.
6. Manual verification (per `/verify`): toggle individual rows, select-all/none,
   run Save/Delete/Set Default in both scopes, confirm partial selections only
   affect checked rows, confirm agents never show "Set Default" in the bulk bar,
   and confirm MCP selection survives `activeScope` switch because the visible
   managed-server list itself does not change.

---

## Open Questions

- Should `selectedIds` reset when switching the AgentSkills `activeType`
  (agent ↔ skill)? Recommendation: yes — those views show different row sets,
  so reset to "all selected" on type switch.
- Should MCP `selectedIds` reset when switching `activeScope`? Recommendation:
  no — the managed MCP list is a merged cross-scope view, so changing the
  top-level write scope does not change the visible row set. Preserve selection
  across scope switches and let the normal reconciliation logic react only when
  the actual server list changes.
- Bulk "Set Default" replaces the defaults array wholesale (for the visible
  set) rather than offering separate "add selected to defaults" / "remove
  selected from defaults" actions. If that proves confusing in practice, a
  follow-up could split it into two actions, but starting with a single
  "replace" action keeps the action list short and matches the checkbox
  mental model ("this is the set").
