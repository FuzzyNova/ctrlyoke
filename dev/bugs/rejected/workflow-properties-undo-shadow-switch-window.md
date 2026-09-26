# Workflow properties undo shadow not reset during workflow switch

- **Found:** before 2026-09 (migrated from `dev/KNOWN_ISSUES.md` #1)
- **Area:** `src/ui/webview-react/store/workflowStore.ts` undo shadow
- **Resolution:** rejected: accepted known issue, not observable in practice (see "Why we're not fixing it")

**Symptom:** When switching workflows, there is a brief window where triggering undo
operates against the _previous_ workflow's property baseline rather than the new one.
A user who managed to undo during this window could have the previous workflow's property
values (harness, model, endCondition, etc.) applied to the new workflow.

**Root cause:** The undo system for workflow properties uses a shadow copy
(`undoWorkflowProperties` in `workflowStore`) as its baseline. Two functions update it:

- `setUndoWorkflowProperties(props)` — records a user-initiated change (creates undo entry)
- `syncIncomingWorkflowProperties(props)` — silently resets the shadow without creating an
  undo entry (used for incoming extension messages)

Previously, `applyWorkflowChange` (called on `SESSION_RESTORED`) called
`syncIncomingWorkflowProperties({})` to reset the shadow immediately. This was removed in
commit `7b30509` to fix a visible flash: clearing the shadow caused the PropertiesPanel to
render once with global defaults before `WORKFLOW_PROPERTIES_UPDATE` arrived with the real
values. The fix retains the previous workflow's shadow until `WORKFLOW_PROPERTIES_UPDATE`
arrives (sent by `sendWorkflowPropertiesToSettings` right after replay), at which point
`syncIncomingWorkflowProperties(normalized)` resets it correctly.

The window is the gap between `SESSION_RESTORED` (clears prompts/history) and
`WORKFLOW_PROPERTIES_UPDATE` (resets undo shadow) — two sequential `postMessage` calls with
no `await` between them, processed in the same event-loop turn in practice.

**Why we're not fixing it:** The two messages are issued back-to-back synchronously, so
the JS message pump delivers them in the same turn and React batches both updates into one
render. Interacting with the undo stack between those two messages is not physically possible
under normal operating conditions. The ~16 ms figure assumes one full render cycle elapses
between the two messages, which does not happen on any current platform.

**Proper fix if it ever becomes observable:** Combine `SESSION_RESTORED` and
`WORKFLOW_PROPERTIES_UPDATE` into a single atomic message. `applyWorkflowChange` would then
receive both the session state and the new workflow properties simultaneously, allowing it to
call `syncIncomingWorkflowProperties(normalized)` in the same handler with no intervening
render cycle.
