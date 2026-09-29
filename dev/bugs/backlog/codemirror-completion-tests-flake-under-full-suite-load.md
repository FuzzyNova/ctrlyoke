# CodeMirror completion tests flake under full `npm test` load

- **Found:** 2026-09-28 by the settings-search orchestrator review pass (claude-cli)
- **Area:** `src/ui/webview-react/test/components/shared/{AdditionalArgsEditor,BranchNameEditor}.test.tsx`
- **Severity:** low

## Symptom

Two consecutive full `npm test` runs on `small-feature` each failed one different
UI test, both of which assert on CodeMirror autocompletion suggestions:

- `AdditionalArgsEditor > offers value hints after a flag token` — `Test timed out in 20000ms`.
- `BranchNameEditor > turns a matching response into suggestions` — `Unable to find an
element with the text: feat/new` (the completion popup had not rendered yet).

Both files pass consistently when run on their own (`npx vitest run <file>`), and
neither component was touched by the commits under review.

## Steps to Reproduce

1. `npm test` (three suites concurrently, full machine load).
2. Occasionally one CodeMirror completion test fails; which one varies by run.
3. Re-running the single file passes.

## Root Cause

Not confirmed. The likely shape is the one `test.instructions.md` describes for
wall-clock-sensitive tests: CodeMirror's completion source runs asynchronously (and
`BranchNameEditor` resolves suggestions from a posted response), so a one-shot
`getByText` or a default-timeout `findBy*`/`waitFor` races the scheduler when
Vitest shares the machine with six extension hosts.

## Suggested Fix

Use `findByText`/`waitFor` with a timeout comfortably longer than the completion
debounce under load (not a single synchronous `getByText` after the triggering
keystroke), and check whether either test awaits a real timer that could be
driven with fake timers instead. If it still won't reproduce, add assertion
messages that capture the editor state and completion status at failure time.
