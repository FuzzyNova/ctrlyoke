# Workflow Favorites Plan

## Goal

Add a per-row star (favorite) button to the **Workflows** section of the `WorkflowStatus` dropdown. Favorites sort to the top of the Workflows section (below the Running Workflows section) and persist across sessions.

---

## Storage Decision: Working File Metadata

Store `isFavorite?: boolean` directly on the working file (`.flightpath/.queue/*.flightpath.json`).

**Rationale:**

- The `WorkflowSerializer.handleGetRecentWorkflows` already reads every working file and projects a subset of fields to the webview — adding `isFavorite` is a trivial one-field addition with no extra I/O.
- No sync issue: if the working file is deleted (via "Remove from history"), the favorite status is deleted with it automatically.
- The working file already carries user-specific runtime state (`_runtime`, `startedAt`, etc.), so `isFavorite` fits naturally and is not semantically wrong to keep here.
- The "shared working file" edge case (user A sharing their `.flightpath.json` to user B) is not a supported or recommended workflow — working files contain run-specific runtime data that makes them inherently personal. No special handling needed.
- `isFavorite` must **not** appear in the clean `PromptFile` emitted by `handleSaveWorkflow` — it must be excluded from `WORKFLOW_FIELDS` just like `workflowName`, `startedAt`, and `_runtime` are today.

---

## Implementation Steps

### 1. Types — `src/types/FlightPathTypes.ts`

Add the optional field to `WorkingFile`:

```ts
export interface WorkingFile extends PromptFile {
  originalFile?: string;
  workflowName: string;
  startedAt: number;
  lastModifiedAt?: number;
  isFavorite?: boolean; // NEW
  _runtime?: WorkingFileRuntime;
}
```

### 2. Message Types — `src/types/DashboardConstants.ts`

Add one new message type constant:

```ts
TOGGLE_WORKFLOW_FAVORITE: "toggleWorkflowFavorite", // Webview -> Extension: { filePath }
```

This follows the existing pattern of `REMOVE_WORKFLOW_HISTORY` and other `filePath`-keyed workflow messages.

### 3. Backend — `src/ui/WorkflowSerializer.ts`

**3a. Include `isFavorite` in the recent workflows response**

In `handleGetRecentWorkflows`, add `isFavorite` to each returned workflow object:

```ts
return {
  filePath,
  workflowName:
    workingFile.workflowName || file.replace(".flightpath.json", ""),
  executionState,
  startedAt: workingFile.startedAt || 0,
  lastModifiedAt: lastModified,
  isFavorite: workingFile.isFavorite ?? false, // NEW
};
```

**3b. Add `handleToggleFavorite`**

New method in `WorkflowSerializer`:

```ts
async handleToggleFavorite(filePath: string): Promise<void> {
  try {
    const workingFile = await readJsonFile(filePath);
    workingFile.isFavorite = !workingFile.isFavorite;
    await fs.writeFile(filePath, JSON.stringify(workingFile, null, 2), "utf-8");
  } catch (error) {
    Log.error("Failed to toggle workflow favorite:", error);
  }
}
```

No postMessage reply needed — the webview updates its own local state optimistically (see step 6).

**3c. Confirm `isFavorite` is excluded from `handleSaveWorkflow`**

`WORKFLOW_FIELDS` in `handleSaveWorkflow` already whitelists only known `PromptFile` fields. Since `isFavorite` is not in that whitelist, it will be naturally excluded. No change needed here — just verify via a quick audit during implementation.

### 4. Message Router — `src/ui/WebviewMessageRouter.ts`

Wire the new message type:

```ts
case MESSAGE_TYPES.TOGGLE_WORKFLOW_FAVORITE:
  await serializer.handleToggleFavorite(message.filePath);
  break;
```

### 5. Webview Types — `RecentWorkflow` interface

Both `WorkflowStatus.tsx` and `RecentWorkflows.tsx` define a local `RecentWorkflow` interface. Add `isFavorite`:

```ts
interface RecentWorkflow {
  workflowName: string;
  filePath: string;
  executionState: string;
  lastModifiedAt?: number;
  startedAt?: number;
  isFavorite?: boolean; // NEW
}
```

### 6. `WorkflowStatus.tsx` — Sorting + Toggle Handler

**6a. Sort favorites to top** after receiving `RECENT_WORKFLOWS`:

```ts
if (message.type === MESSAGE_TYPES.RECENT_WORKFLOWS) {
  const workflows: RecentWorkflow[] = message.workflows || [];
  const sorted = [
    ...workflows
      .filter((w) => w.isFavorite)
      .sort((a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0)),
    ...workflows
      .filter((w) => !w.isFavorite)
      .sort((a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0)),
  ];
  setRecentWorkflows(sorted);
}
```

**6b. Add `handleToggleFavorite` callback:**

```ts
const handleToggleFavorite = useCallback(
  (filePath: string) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.TOGGLE_WORKFLOW_FAVORITE,
      filePath,
    });
    // Optimistic local update — flip isFavorite and re-sort
    setRecentWorkflows((prev) => {
      const updated = prev.map((w) =>
        w.filePath === filePath ? { ...w, isFavorite: !w.isFavorite } : w
      );
      return [
        ...updated
          .filter((w) => w.isFavorite)
          .sort((a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0)),
        ...updated
          .filter((w) => !w.isFavorite)
          .sort((a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0)),
      ];
    });
  },
  [vscode]
);
```

**6c. Pass the handler to `<RecentWorkflows>`:**

```tsx
<RecentWorkflows
  ...
  onToggleFavorite={handleToggleFavorite}
/>
```

### 7. `RecentWorkflows.tsx` — Star Button UI

**7a. Update props:**

```ts
interface RecentWorkflowsProps {
  ...
  onToggleFavorite?: (filePath: string) => void;
}
```

**7b. Add star button to each row, alongside the existing delete button:**

The star sits to the left of the trash icon. Follow the same `opacity-0 group-hover:opacity-100` pattern for non-favorited items, but always show (full opacity) for favorited items so users can see their favorites at a glance without hovering.

```tsx
{
  onToggleFavorite && (
    <button
      type="button"
      title={workflow.isFavorite ? "Remove from favorites" : "Add to favorites"}
      aria-label={
        workflow.isFavorite ? "Remove from favorites" : "Add to favorites"
      }
      onClick={(e) => {
        e.stopPropagation();
        onToggleFavorite(workflow.filePath);
      }}
      className={`flex-shrink-0 p-0.5 rounded transition-colors
      ${
        workflow.isFavorite
          ? "text-yellow-400 hover:text-yellow-300 hover:bg-toolbar-hover-bg"
          : "opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-yellow-400 hover:bg-toolbar-hover-bg"
      }`}
    >
      <i
        className={`codicon ${workflow.isFavorite ? "codicon-star-full" : "codicon-star"}`}
      />
    </button>
  );
}
```

Place the star button before the delete button in the JSX so the column order is: name | state badge | time | ⭐ | 🗑

---

## Out of Scope

- No favorites UI in the Running Workflows section (those are transient/in-memory instances, not history entries).
- No favorite indicator on the main split button (workflow name button).
- No favorites in the "Clear History" flow — clearing history deletes all entries including favorites; this is the existing behavior and remains unchanged.
- The `isFavorite` field must not appear in saved `.flightpath.yaml/.json` workflow files. The `WORKFLOW_FIELDS` whitelist in `handleSaveWorkflow` already ensures this — no change needed.

---

## File Change Summary

| File                                                           | Change                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/types/FlightPathTypes.ts`                                 | Add `isFavorite?: boolean` to `WorkingFile`                                                     |
| `src/types/DashboardConstants.ts`                              | Add `TOGGLE_WORKFLOW_FAVORITE` message type                                                     |
| `src/ui/WorkflowSerializer.ts`                                 | Add `handleToggleFavorite`; include `isFavorite` in recent workflows response                   |
| `src/ui/WebviewMessageRouter.ts`                               | Wire `TOGGLE_WORKFLOW_FAVORITE` to `handleToggleFavorite`                                       |
| `src/ui/webview-react/components/workflow/WorkflowStatus.tsx`  | Add sort logic + `handleToggleFavorite` callback; pass to `RecentWorkflows`                     |
| `src/ui/webview-react/components/workflow/RecentWorkflows.tsx` | Add `isFavorite` to `RecentWorkflow` interface; add `onToggleFavorite` prop; render star button |
