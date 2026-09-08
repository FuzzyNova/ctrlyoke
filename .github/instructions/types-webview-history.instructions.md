---
applyTo: "src/types/{WebviewMessageTypes.ts,OutputHistoryTypes.ts,WorkflowTimelineTypes.ts}"
---

<webviewContracts>
- `WebviewMessageTypes.ts` is the extension↔webview contract layer and re-export hub. React stores/components should consume shared payload types from here rather than reaching into multiple sibling files.
- Keep payload interfaces aligned with `MESSAGE_TYPES` and the actual router/provider implementations. Adding a message type without updating the runtime handlers creates silent drift.
</webviewContracts>

<historyAndTimeline>
- `WorkflowTimelineTypes.ts` defines the persisted append-only run history format (`manifest.json` + `events.jsonl`). Preserve the draft-vs-persisted event pair pattern and keep legacy event types only for read compatibility.
- `OutputHistoryTypes.ts` is the projected/read model used by the UI. `orderedEntries` is the canonical ordered output stream; `StepOutput` now carries only workspace snapshot and undo metadata.
- Targeted history/timeline entries use `OutputExecutionTarget` so queue steps and final-step loops share one addressing model. Reuse that instead of inventing parallel step/loop target shapes.
- **A target alone does not identify a step's own output — `phase` is part of the identity.** A pre/end condition or worktree-setup script emits `OrderedCliHistoryEntry`s at the *same* `stepIndex`/`loopIndex`, and they land *after* the AI output, so "last CLI entry for this step" silently resolves to the condition script: no `tokens` (no context-window bar, no token total), no session ID, and the script's own `elapsed` instead of the step's. That is what dropped the context bar from exactly the two steps in a six-step run that had end conditions, replacing their 138.4s/171.2s durations with 0.1s/2.3s. Any per-step derivation must filter with `isPromptExecutionPhase(entry.phase)` (`DashboardConstants.ts`) rather than testing `phase` inline — absent means the prompt phase, and a script *step*'s own output is prompt-phase too, so a hand-rolled `=== undefined` check drifts. `useLatestStepOutput`, `useContextPct`, and `workflowStore.getLatestOutput` are the consumers.
</historyAndTimeline>

<dependencyGotcha>
`WebviewMessageTypes.ts` and `OutputHistoryTypes.ts` reference each other for shared type aliases. Keep both files type-focused; avoid introducing new runtime helpers/constants that would turn that relationship into a fragile runtime cycle.
</dependencyGotcha>
