# Reply to Step Plan

## Goal

Add a **Reply to Step** item to the step context menus. It must work on queue steps
(`useStepContextMenu`) and on the final step (`useFinalStepContextMenu`). One click
sets the new-prompt editor up as a follow-up to that step:

- Every prompt property in `PropertiesDrawer` is set to the **resolved** value the
  replied-to step actually ran with (harness, model, agent, skills, and so on). Values
  are written as explicit overrides, not "Inherit".
- **Resume Session** is set to **Yes**.
- **Session ID** is set to the concrete session ID that the replied-to step produced.

The user only has to type the follow-up question and press Add. Today they have to use
Copy Metadata, find the session ID, paste it, then set the harness, model, agent and
skills one at a time to match the original step.

No existing backlog doc covers this. `dev/backlog/` has no "reply", "follow-up" or
"resume from step" plan.

## Current state (what we build on)

| Concern | Where | Notes |
| --- | --- | --- |
| Shared menu item builders | `src/ui/webview-react/utils/stepContextMenuItems.ts` | `buildStepCopyMenuItems` is used by both menus. The new builder goes next to it. |
| Queue-step menu | `hooks/useStepContextMenu.tsx` → `openContextMenu(x, y, { step, deleteIndex, runtimeMeta, latestOutput, … })` | Called from `WorkflowStepsPanel.tsx` and `PromptChipRail.tsx`. |
| Final-step menu | `hooks/useFinalStepContextMenu.tsx` | Called from the same two components. |
| Editor state | `store/editorStore.ts`: `PropertyValues`, `PROPERTY_DEFAULTS`, `enterNewPromptMode`, `setProperties`, `preparePromptEditorForInsert` | `sessionId` is a `string` in the editor (`""` = blank). |
| Step → editor mapping | `editorStore.enterEditMode` builds `propertiesFromData` inline | This is the authored mapping. The reply mapping is similar but works on *resolved* values (see §2). |
| Property resolution | `resolveExecutionProperties()` in `src/types/ExecutionPropertyResolver.ts` | It is platform-neutral and already runs in the webview via `useCompatibilityDiagnostics`. The settings adapter `createDefaults(globalSettings)` and `toCoreWorkflow()` are private to that hook. |
| What actually ran | `step._runtime` (`PromptRuntimeMetadata extends ExecutionProperties`) | `CliPromptRuntimeCoordinator` writes the actual `harness`, `model`, `executionMode`, `agent`, `skills`, `secrets` and `sessionId` on completion and on cancel. The webview mirror type in `WebviewMessageTypes.ts` (~l.393) declares only `harness`, `model` and `sessionId`. |
| Session ID sources | `stepMetadataClipboard.ts` uses `latestOutput?.structured?.metadata?.sessionId ?? runtimeMeta?.sessionId` | `step._runtime.sessionId` is the persisted value. |
| Session ID semantics | `sessionId` accepts a UUID string, a step number, or `SESSION_ID_SENTINELS.FINAL_STEP` | We copy the concrete ID, as requested (see §5). |

## Design

### 1. Menu item

Add `buildReplyToStepMenuItem(input): StepContextMenuItem` to
`stepContextMenuItems.ts`, and have both hooks call it. That way the label, icon and
disabled logic live in one place, just like the copy items.

- Label: `Reply to Step`. Icon: `codicon-reply`.
- Placement: its own group directly after the Copy items. It sits before the output
  filter items in both menus.
- Disabled when:
  - the step is a script step (`isScriptWorkflowStep`). Title: *"Script steps have no
    AI session to reply to"*.
  - no session ID can be found (the step hasn't run, it failed before a session
    started, or the harness never reported one). Title: *"This step has no session to
    resume yet"*.
- **Not** disabled for externally-managed or read-only workflows, running workflows,
  or history view. Reply only writes to the local new-prompt editor draft. Adding the
  draft to the queue goes through the editor's normal Add path, and that path already
  enforces those locks.
- Pass the session ID into the builder from the hook's existing `latestOutput` /
  `runtimeMeta` / `step._runtime.sessionId`. Add one small helper,
  `getStepSessionId(step, latestOutput, runtimeMeta)`, and use it here and in
  `stepMetadataClipboard.ts` so the fallback order is defined in one place.

### 2. Building the reply properties (the core of the feature)

Add a new pure util, `src/ui/webview-react/utils/replyToStep.ts`:

```ts
export function buildReplyPropertyValues(input: {
  step: PromptWorkflowStep;          // queue step or final step
  sessionId: string;
  workflowProperties: WorkflowProperties;
  globalSettings: GlobalSettings;
}): PropertyValues
```

Algorithm:

1. **Resolve** the step with `resolveExecutionProperties(toCorePromptStep(step),
   toCoreWorkflow(...), { defaults: createDefaults(globalSettings),
   hostCanProvidePty: true })`. First move `createDefaults`, `toCoreWorkflow` and
   `toCorePromptStep` out of `useCompatibilityDiagnostics.ts` into a shared webview
   util (e.g. `utils/coreWorkflowAdapter.ts`). Both callers then share one adapter
   (DRY). Do not write a second resolver.
2. **Overlay `_runtime` where it records the actual executed value.** Resolution uses
   *today's* workflow and settings, but the step may have run under older ones (the
   settings changed, or the user is replying from history). `_runtime` wins for the
   fields it records: `harness`, `model`, `executionMode`, `agent`, `skills`,
   `secrets`. This matters most for harness and model: a session ID only resumes
   under the harness that created it. Widen the webview `_runtime` type in
   `WebviewMessageTypes.ts` to declare the extra fields the core already sends
   (`executionMode`, `agent`, `skills`, `secrets`). Check that serialization actually
   passes them through to the webview.
3. **Strip injected built-in skills.** In ctrlyoke-MCP *skill* mode, the resolver (and
   so `_runtime.skills`) adds `MCP_SKILL_NAMES.TOOLS` / `.COORDINATION` to the list.
   Copying those back as explicit skills would pin them into the new step for good.
   Remove every `MCP_SKILL_NAMES` value before writing `skills`.
4. **Map resolved values to explicit editor values.** "None" becomes an explicit
   `null` override, never `undefined` (inherit):
   - `agent`: string, or `null` when the resolved value has no agent.
   - `skills` / `secrets`: array, or `null` when empty.
   - `mcpServers` / `hooks`: resolved array, or `null`.
   - `additionalArgs`: string, or `null`.
   - `toolPermissions`: resolved `{ mode, allowedTools, deniedTools }`, or `null` when
     it resolved to none.
   - `endCondition`, `preCondition`, `errorBehavior`: see §3.
   - `priorContext`: see §3.
   - `color`: copy the authored `step.color` (it is display-only and not part of
     resolution).
5. **Set the session fields last:** `resumeSession: true`, `sessionId: <concrete id>`.

The util takes plain inputs and reads no stores, so it can be unit-tested without
React.

### 3. Fields that are not copied verbatim (decided)

"Identical to resolved" applies to every field except one:

| Field | Behaviour | Why |
| --- | --- | --- |
| `priorContext` | Explicit **None** (`NONE` keyword) | The resumed session already holds the earlier conversation. Injecting prior outputs again duplicates context and costs tokens. |
| `endCondition` | Copy as resolved | It is usually the same validation gate the user wants on a follow-up. It is visible and easy to clear in the drawer. |
| `preCondition` | Copy as resolved | Same reason as `endCondition`. |
| `errorBehavior` | Copy as resolved | Same reason as `endCondition`. |

### 4. Editor behaviour on click

There is no modal, no toast, and the Properties drawer does not open. The only
feedback is the reply banner (§5).

Add a new editor-store action, `startReplyToStep(reply: ReplyContextInput)`. The
input carries the reply `PropertyValues` plus the banner data: session ID, harness,
and a source label such as `Step 3` or `Final step`.

1. If the editor is in edit mode (a queue step or the final step is selected), call
   `deselect()`. That caches the in-progress edit in `pendingEdits`, and the reply
   does not overwrite an existing step's definition.
2. `enterNewPromptMode()`. **Before** changing anything, take a snapshot of the
   new-prompt draft's `properties` and `stepType`. This snapshot is what Cancel
   restores (§5).
3. **Replace** `properties` wholesale with the reply values. Do not merge: stale
   overrides from an earlier draft would silently survive. Set `stepType` to prompt.
   **Keep `promptText`**, because the user may have started typing the follow-up
   already. Mark the draft dirty.
4. Store `replyContext = { sessionId, harness, sourceLabel, previous: snapshot }` on
   the editor store.
5. Expand the editor if it is collapsed. Reuse the expansion half of
   `preparePromptEditorForInsert()` by splitting it into a small shared helper; don't
   enqueue an insert.

If the user clicks Reply again while a reply is already active, **keep the original
`previous` snapshot**. Only the properties and banner data change. Cancel always
returns to the state from before the *first* reply, not to an earlier reply.

### 5. Reply banner in `EditorSection`

`EditorSection.tsx` renders a banner row between the section header and the
`prompt-editor-wrapper`. It only shows while the editor is in new-prompt mode and
`replyContext` is set:

```
 ↩  Replying to Claude Code session 3f2a9c1e…   (Step 3)            Cancel
```

- **Text:** `Replying to <HARNESS_DISPLAY_NAMES[harness]> session <id>`, then the
  source label, dimmed. Truncate the session ID visually (first 8 characters plus
  `…`) and put the full ID in `title`. At compact width, drop the source label first.
  The existing `useElementTier` tiers in `EditorSection` already cover this.
- **Icon:** `reply`. **Tone:** info, using `--status-info` from `globals.css`. The
  pause banner uses warning because it is an alert; a reply is not.
- **Cancel** reverts the reply: it restores `previous.properties` and
  `previous.stepType`, then clears `replyContext`. Cancel **keeps** `promptText`,
  because text typed after replying is the user's own work. Cancel does not
  navigate back to a step that was being edited before the reply. That edit is still
  in `pendingEdits` and one click away.
- **Accessibility:** `role="status"` with an `aria-label` that repeats the full text,
  like the header banners.

**Sharing code with `HeaderStatusBanner`.** Pull the banner row markup (icon,
message, right-aligned action buttons, tone) and the private `BANNER_TEXT_CLASS` out
of `HeaderStatusBanner.tsx` into a shared `components/shared/StatusBanner.tsx`, with
a typed `tone` prop (`error` / `warning` / `info`). `HeaderStatusBanner` then renders
its four banners through it, and the reply banner uses it too. This avoids a fifth
copy of the same `flex items-center gap-2 px-3 py-1.5 …` row.

**When `replyContext` clears on its own (without reverting):**

- **Submit.** The draft is added or run. `resetEditor()` already runs on every submit
  path in `PromptEditor.tsx`. `replyContext` goes in the state that `resetEditor`
  resets, so no submit path needs its own code.
- **The banner stops being true.** The user sets the harness, **Session ID** or
  **Resume Session** to something that no longer matches `replyContext`. Once the
  draft isn't a reply any more, the banner shouldn't claim it is. Clear
  `replyContext` in `setProperties` / `setProperty` when a change breaks the match.
  Changing any other property (model, skills, conditions, …) keeps the banner.
- **Reset all to inherit** in the drawer header. This is the same case as above,
  because it sets harness and session fields back to inherit.

**When it stays:**

- **Editing another step.** While a queue step or the final step is being edited,
  the banner is hidden. It comes back when the user returns to the new-prompt
  draft, because `replyContext` belongs to that draft.
- **Switching workflows.** The workflow-switch path in `useMessageHandler.ts`
  (~l.457) only clears `pendingEdits`; the new-prompt draft survives. So **Reply to
  Step in workflow A, then open or create workflow B, then Add** puts a step into B
  that resumes A's session. This "continue it in a new workflow" flow is why the
  plan copies the concrete session ID and not a step number (§6): a step number
  would point at the wrong step in B.
- **Reload.** Save `replyContext` together with the draft in `saveToVsCodeState` /
  `restoreFromVsCodeState`, and include it in `SavedNewStepState` (via
  `captureNewStepDraft` / `restoreNewStepDraft`). The banner then survives a reload
  and the edit-mode round trip, just like the properties it describes.

Leave `AutoResumeStatusRow` in the drawer as it is. It already hides itself when the
Session ID field has an explicit value.

### 6. Session ID choice (why the concrete ID; decided)

The field also accepts a step number (`3`) or `SESSION_ID_SENTINELS.FINAL_STEP`. The
concrete UUID is the right choice here:

- A step number is re-resolved at run time and can point somewhere else after a
  reorder, a rewind or a new run. The UUID always resumes the exact conversation the
  user right-clicked.
- Only the UUID works across workflows. It is what makes replying into a different
  or brand-new workflow work (§5).
- For the final step, the sentinel means "the most recent final-step session". That
  can be a later loop than the one the user is looking at. The UUID in
  `finalStep._runtime.sessionId` (or the loop's `latestOutput`) is exact.

Replying from **history view** also copies that run's session ID. That is intended:
the harness session still exists locally even though the run is old. If the harness
has since deleted it, the normal resume-failure path handles it. No new error
handling is needed.

### 7. Parallel groups

Steps inside a parallel group each have their own `_runtime.sessionId`, so replying to
one member works unchanged. The reply draft is added through the normal Add path, at
the end of the queue, outside any group.

## Implementation steps

1. Extract `createDefaults` / `toCoreWorkflow` / `toCorePromptStep` from
   `useCompatibilityDiagnostics.ts` into a shared webview util. Update the hook to
   import them. This is a pure refactor, so existing tests must pass unchanged.
2. Widen the webview `_runtime` type (`WebviewMessageTypes.ts`) with
   `executionMode`, `agent`, `skills`, `secrets`. Confirm the dashboard serializer
   forwards them.
3. Add `getStepSessionId()` and switch `stepMetadataClipboard.ts` to use it.
4. Add `utils/replyToStep.ts` with `buildReplyPropertyValues()`.
5. Add `replyContext` and the `startReplyToStep()` / `cancelReplyToStep()` actions to
   `editorStore` (§4, §5). Cover the auto-clear rules in the property setters, and
   add `replyContext` to `resetEditor`, `SavedNewStepState` and the VS Code state
   save/restore.
6. Extract `components/shared/StatusBanner.tsx` from `HeaderStatusBanner.tsx` and
   move the header banners onto it. This is a pure refactor, so existing header
   banner tests must pass unchanged.
7. Render the reply banner in `EditorSection.tsx` (§5).
8. Add `buildReplyToStepMenuItem()` to `stepContextMenuItems.ts`. Wire it into
   `useStepContextMenu` and `useFinalStepContextMenu`. Each hook reads
   `workflowProperties` / `globalSettings` through `useSettingsStore.getState()` at
   click time, so the callbacks don't pick up new dependencies.
9. Read `.github/instructions/webview-react*.instructions.md` before editing, then run
   `npm run typecheck`, `npm run lint`, `npm test`.

## Progress

Each implementation session ticks its items here in the commit that lands them, and
records any deviation from the design above in that section of this doc.

- [x] Foundations: shared core-workflow adapter (impl step 1), widened webview
      `_runtime` type (2), `getStepSessionId()` (3)
- [x] `buildReplyPropertyValues()` in `utils/replyToStep.ts` (4)
- [x] Editor store `replyContext`, `startReplyToStep()` / `cancelReplyToStep()` (5)
- [x] `StatusBanner` extraction (6) and reply banner in `EditorSection` (7)
- [ ] Context menu item wired into both step menus (8), full gate green (9)

Foundation implementation note: `getStepSessionId()` lives in
`utils/stepMetadataClipboard.ts` beside `StepRuntimeMetaSnapshot`. The dashboard
run-view path passes `workingFile.steps` and `workingFile.finalStep` directly
through `RunViewPublisher`/`useMessageHandler` into `workflowStore`, retaining
step `_runtime`. The queue snapshot path likewise forwards prompt steps without
stripping `_runtime`. `WorkflowSerializer.buildCleanWorkflow()` strips runtime
metadata only for authored save/template-export output; it is not the dashboard
run-view serializer. No forwarding change was needed.

Builder implementation note: the shared core adapter now forwards `secrets`
from prompt, workflow, and global settings projections. The extracted adapter
had omitted these existing fields, which otherwise prevented the builder from
resolving authored or inherited secrets.

Editor-store implementation note: `replyContext` is part of the shared new-step
draft capture/restore path, including pending edits and VS Code state. Returning
to a saved reply draft counts as dirty even when its prompt text is empty. No
deviation from §4/§5.

Banner implementation note: `StatusBanner` now owns the shared tone colors,
contrast text treatment, icon, status role, and right-aligned action slot. The
reply banner uses the editor's compact tier to hide its source label. No
deviation from §5.

## Tests (`src/ui/webview-react/test/**`)

- `utils/replyToStep.test.ts`:
  - authored overrides resolve correctly.
  - inherit-from-workflow and inherit-from-settings resolve to explicit values.
  - "none" values become `null`, not `undefined`.
  - `_runtime` harness/model win over re-resolution when settings have changed.
  - built-in MCP skills are stripped.
  - `resumeSession === true` and `sessionId` is the concrete ID.
  - `priorContext` is set to explicit None (§3).
- `hooks/useStepContextMenu.test.tsx` and `hooks/useFinalStepContextMenu.test.tsx`:
  - the item is present.
  - it is disabled for script steps and for steps with no session ID, with the right
    titles.
  - clicking it populates the editor store.
- `store/editorStore` tests for `startReplyToStep`:
  - an in-progress edit of another step is preserved in `pendingEdits`.
  - `promptText` is kept.
  - the properties are replaced, not merged.
  - Cancel restores the pre-reply properties and `stepType`, keeps `promptText`, and
    clears `replyContext`.
  - a second reply keeps the original `previous` snapshot.
  - changing harness, Session ID or Resume Session clears `replyContext`; changing
    the model does not.
  - `resetEditor` clears it.
  - it survives an edit-mode round trip and a VS Code state save/restore.
- `components/layout/EditorSection` test:
  - the banner shows the harness display name and the truncated session ID, with the
    full ID in `title`.
  - it is hidden in edit mode.
  - Cancel calls the revert action.
- `components/layout/HeaderStatusBanner` tests pass unchanged after the
  `StatusBanner` extraction.

## Decided

- `priorContext` is set to None on reply.
- The concrete session ID is copied, never a step number or sentinel.
- No drawer auto-open, no modal, no toast. The editor banner with Cancel is the only
  feedback.

## Out of scope for v1

- A keyboard shortcut, or a reply icon on the step card on hover. The context menu is
  the entry point, and it also covers touch (long-press) in the hosted dashboard.
