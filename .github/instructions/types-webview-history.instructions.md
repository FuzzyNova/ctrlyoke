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
</historyAndTimeline>

<dependencyGotcha>
`WebviewMessageTypes.ts` and `OutputHistoryTypes.ts` reference each other for shared type aliases. Keep both files type-focused; avoid introducing new runtime helpers/constants that would turn that relationship into a fragile runtime cycle.
</dependencyGotcha>
