# End-Condition Pass Retry

> **Last Updated:** July 29, 2026
> **Status:** Proposed — `onPass: retry` is intentionally unavailable until orchestrator loop support exists.

## Use Case

Some workflows should keep asking the harness to implement more backlog items
while a validation command remains green. An end condition that passes after
one prompt can be a signal to run that same prompt again, allowing the harness
to continue making incremental progress without adding a separate workflow
step for every item.

## Why the Option Was Removed

`onPass: retry` was previously accepted by the schema and advertised by YAML
completion, but `EndConditionHandler` advanced to the next step instead. The
only indication was a debug-log warning, so a valid-looking workflow silently
did the wrong thing.

The audit therefore removed `retry` from `endCondition.onPass` while keeping
`onFail: retry` unchanged. This makes the unsupported selection fail during
schema validation instead of being downgraded to `continue`. Removing the
broken option does not reject the use case; it preserves it here for a future
implementation.

## Required Architecture

Real pass retries need orchestrator-level loop support, including a way to
re-enter the completed prompt without advancing the queue, coordinate the
prompt and end-condition attempt state, and apply retry limits and session
resume behavior consistently. The implementation must also keep dashboard
history, runtime persistence, cancellation, and final-step execution coherent
when a passing condition loops back to the same prompt.

When that support exists, restore the option in the shared type, JSON/YAML
schemas, completion text, and tests together. Until then, `onPass` supports
only `continue` and `stopWorkflow`.
