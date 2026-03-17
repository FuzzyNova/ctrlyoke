# Webview React Test Coverage Plan

## Executive Summary

The `src/ui/webview-react/` package has near-zero test coverage. One test file exists
(`workflowStore.temporal.test.ts`, 358 lines) covering only undo/redo behaviour. The
testing infrastructure is already wired up correctly (Vitest + jsdom + React Testing
Library), so the gap is purely unwritten tests, not missing tooling.

**Current state:**
- 43 components — 0% tested
- 4 stores — ~5% tested (undo/redo only in `workflowStore`)
- 6 hooks — 0% tested
- 12 utility modules — 0% tested
- ~20,000 lines of production code vs ~400 lines of test code

---

## Running Tests Today

```bash
# Run once
npm run test:ui

# Watch mode (TDD)
npm run test:ui:watch

# Generate HTML/JSON coverage report
npm run test:ui:coverage
```

Coverage output lands in `coverage/` (gitignored). Open `coverage/index.html` in a
browser for the full interactive report.

---

## Coverage Tooling

### Built-in: Vitest v8 Coverage

Already configured in `vitest.config.ts`:

```ts
coverage: {
  provider: "v8",
  include: ["store/**", "hooks/**", "utils/**", "components/**"],
  exclude: ["test/**", "types/**"],
}
```

Running `npm run test:ui:coverage` produces per-file line/branch/function metrics.
No additional packages are required — `@vitest/coverage-v8` is already a dev
dependency.

**Tip:** Add thresholds to fail CI when coverage drops below a floor:

```ts
// vitest.config.ts
coverage: {
  provider: "v8",
  thresholds: {
    lines: 60,
    functions: 60,
    branches: 50,
  },
  // existing config...
}
```

### Optional: Istanbul / c8 Reporter

If you want a different coverage algorithm (Istanbul handles some transpiled patterns
better than v8), swap `provider: "v8"` for `provider: "istanbul"` and install
`@vitest/coverage-istanbul`. The HTML report format is identical.

### Optional: Codecov / Coveralls CI Integration

Both services ingest the LCOV report that Vitest emits (`coverage/lcov.info`) and post
coverage diff comments on pull requests. Useful once you establish a baseline.

```bash
# Example GitHub Actions step (after npm run test:ui:coverage)
- uses: codecov/codecov-action@v4
  with:
    files: ./coverage/lcov.info
    flags: webview
```

### Optional: VSCode Coverage Gutters Extension

[Coverage Gutters](https://marketplace.visualstudio.com/items?itemName=ryanluker.vscode-coverage-gutters)
reads `coverage/lcov.info` and decorates the editor with green/red line indicators.
Works without any config change; just run coverage once and toggle the extension.

---

## What to Test and How

The testing pyramid for this package has three layers: **utilities** (pure functions,
easy), **stores** (state machines, medium), **components** (render + interaction, hard).
Start at the bottom.

---

### Tier 1 — Utility Functions (highest ROI, no mocks needed)

All 12 modules in `utils/` are pure or near-pure functions. Writing these tests is
straightforward and provides immediate coverage gains.

#### Priority utilities (by LOC and criticality)

| File | LOC | Why critical |
|------|-----|--------------|
| `outputUtils.ts` | 660 | Formats every CLI event shown in the UI; regressions are invisible until runtime |
| `promptUndo.ts` | 432 | Undo state tree logic; bugs cause data loss |
| `hljsUtils.ts` | 324 | Syntax highlight config; broken config silently falls back to no highlighting |
| `endCondition.ts` | 241 | End condition UI parsing; wrong output means wrong retry UI |
| `prompt.ts` | 248 | Prompt property accessors used throughout the app |
| `status.ts` | 237 | Status string → display label mapping |
| `time.ts` | 124 | Duration/timestamp formatting |
| `string.ts` | 86 | Truncation, escaping |

**Example test skeleton for `time.ts`:**

```ts
// test/utils/time.test.ts
import { formatDuration, formatTimestamp } from "../../utils/time";

describe("formatDuration", () => {
  it("renders seconds under a minute", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });
  it("renders minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
  });
});
```

**Example test skeleton for `status.ts`:**

```ts
// test/utils/status.test.ts
import { getStepStatusLabel, getStepStatusIcon } from "../../utils/status";
import { STEP_STATUSES } from "@shared/DashboardConstants";

describe("getStepStatusLabel", () => {
  it.each([
    [STEP_STATUSES.RUNNING, "Running"],
    [STEP_STATUSES.COMPLETED, "Done"],
    [STEP_STATUSES.ERROR, "Error"],
  ])("maps %s → %s", (status, label) => {
    expect(getStepStatusLabel(status)).toBe(label);
  });
});
```

---

### Tier 2 — Stores (state machines, mock `postMessage`)

The three untested stores follow the same Zustand pattern as the partially-tested
`workflowStore`. The existing `test/setup.ts` already mocks `window.vscodeApi`.

#### `settingsStore.ts` (376 LOC) — start here, least complex

Key things to test:
- Initial state shape
- `loadSettings` populates harness/model options from a message payload
- `setHarness` / `setModel` update state and call `vscodeApi.postMessage`
- `statusInfo` updates on `SET_STATUS_INFO` messages

```ts
// test/store/settingsStore.test.ts
import { useSettingsStore } from "../../store/settingsStore";

beforeEach(() => useSettingsStore.getState().reset?.());

describe("setHarness", () => {
  it("updates active harness and posts message", () => {
    useSettingsStore.getState().setHarness("claude-cli");
    expect(useSettingsStore.getState().harness).toBe("claude-cli");
    expect(window.vscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_HARNESS", harness: "claude-cli" })
    );
  });
});
```

#### `uiStore.ts` (574 LOC)

Key things to test:
- Panel open/close toggles
- `persistState` calls `vscodeApi.setState`
- `restoreState` reads from `vscodeApi.getState()` on init

#### `editorStore.ts` (777 LOC) — most complex

Key things to test:
- `loadPrompt` / `clearEditor` state transitions
- Dirty-state tracking (unsaved edits)
- History push/pop
- `savePrompt` calls `postMessage` with correct payload

#### `workflowStore.ts` — non-temporal methods

The existing temporal test file imports the store but only exercises `zundo` wrappers.
Add a sibling file `test/store/workflowStore.test.ts` covering:
- `loadWorkflow` — verify `prompts`, `name`, `executionState` are set correctly
- `addCliOutput` — output array grows, ordering is preserved
- `setStepStatus` — individual step status updates without touching other steps
- `addRetry` / `removeRetry` — retry lifecycle
- `resetWorkflow` — full state clear

---

### Tier 3 — Hooks (jsdom + `renderHook`)

Use `@testing-library/react`'s `renderHook` + `act` for all hooks.

#### `useMessageHandler.ts` (1,289 LOC) — highest priority hook

This hook is the single entry point for all messages from the VS Code extension. A
regression here breaks the entire webview silently.

Strategy: simulate `window.postMessage` events, assert the correct store state
mutations happen.

```ts
// test/hooks/useMessageHandler.test.ts
import { renderHook, act } from "@testing-library/react";
import { useMessageHandler } from "../../hooks/useMessageHandler";
import { useWorkflowStore } from "../../store/workflowStore";
import { MESSAGE_TYPES } from "@shared/DashboardConstants";

describe("useMessageHandler", () => {
  it("handles LOAD_WORKFLOW message", () => {
    renderHook(() => useMessageHandler());

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.LOAD_WORKFLOW,
            workflow: { name: "My Workflow", prompts: [] },
          },
        })
      );
    });

    expect(useWorkflowStore.getState().name).toBe("My Workflow");
  });
});
```

Priority message types to cover (highest risk first):
1. `LOAD_WORKFLOW` — bootstraps entire UI
2. `STEP_STATUS_CHANGED` — drives step indicator updates
3. `CLI_OUTPUT` / `STATUS_MESSAGE` — drives output panel
4. `EXECUTION_STATE_CHANGED` — start/stop/pause transitions
5. `PROMPTS_EXTENDED` — dynamic queue extension
6. `SETTINGS_LOADED` — initial settings population

#### Remaining hooks

| Hook | Test strategy |
|------|--------------|
| `useUndoRedoKeyHandler` | Fire `keydown` events, assert store undo/redo called |
| `useAttachmentTokenCount` | Mock tokenizer, assert count updates on input change |
| `useMediaQuery` | Mock `window.matchMedia`, verify return value |
| `useElementNarrow` | Mock `ResizeObserver`, verify breakpoint flag |
| `useVsCodeApi` | Assert `acquireVsCodeApi` called once, result cached |

---

### Tier 4 — Components (render + user interaction)

Use `@testing-library/react` with `render`, `screen`, and `userEvent`. Mock stores
with `vi.mock` or by setting store state directly before rendering.

#### Shared UI components — start here (no store dependencies)

These are pure presentational components and the easiest to test:

```ts
// test/components/shared/Button.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "../../../components/shared/Button";

it("calls onClick when clicked", async () => {
  const onClick = vi.fn();
  render(<Button onClick={onClick}>Run</Button>);
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(onClick).toHaveBeenCalledOnce();
});

it("is disabled when disabled prop is true", () => {
  render(<Button disabled>Run</Button>);
  expect(screen.getByRole("button")).toBeDisabled();
});
```

**Priority shared components:**
- `Button` — used everywhere
- `Modal` + `DeleteConfirmModal` + `ResetConfirmModal` — destructive action gates
- `CustomSelect` / `HarnessDropdown` — complex keyboard nav, accessibility
- `ErrorBoundary` — verify fallback renders on throw

#### Output components

`CliOutput.tsx`, `BashOutput.tsx`, `MarkdownText.tsx`, `ToolCallOutput.tsx` are all
render-only; test with fixture data from `outputUtils` test cases for consistency.

#### Workflow components

`WorkflowControls.tsx` and `WorkflowStatus.tsx` have the most user-facing logic (run /
pause / stop buttons with conditional rendering). Test each button's enabled/disabled
states against store state.

#### PromptItem / PromptItemDetails

These render dynamic content from the store; test with a pre-populated store state.

---

## Recommended File Structure for New Tests

Mirror the source directory layout under `test/`:

```
test/
├── setup.ts                              (exists)
├── store/
│   ├── workflowStore.temporal.test.ts    (exists)
│   ├── workflowStore.test.ts             (new)
│   ├── editorStore.test.ts               (new)
│   ├── uiStore.test.ts                   (new)
│   └── settingsStore.test.ts             (new)
├── hooks/
│   ├── useMessageHandler.test.ts         (new — highest priority)
│   ├── useUndoRedoKeyHandler.test.ts     (new)
│   ├── useAttachmentTokenCount.test.ts   (new)
│   ├── useMediaQuery.test.ts             (new)
│   ├── useElementNarrow.test.ts          (new)
│   └── useVsCodeApi.test.ts              (new)
├── utils/
│   ├── outputUtils.test.ts               (new — highest priority)
│   ├── promptUndo.test.ts                (new)
│   ├── status.test.ts                    (new)
│   ├── time.test.ts                      (new)
│   ├── string.test.ts                    (new)
│   ├── prompt.test.ts                    (new)
│   ├── endCondition.test.ts              (new)
│   └── hljsUtils.test.ts                 (new)
└── components/
    ├── shared/
    │   ├── Button.test.tsx               (new — start here)
    │   ├── Modal.test.tsx                (new)
    │   ├── DeleteConfirmModal.test.tsx   (new)
    │   ├── CustomSelect.test.tsx         (new)
    │   ├── HarnessDropdown.test.tsx      (new)
    │   └── ErrorBoundary.test.tsx        (new)
    ├── output/
    │   ├── CliOutput.test.tsx            (new)
    │   ├── BashOutput.test.tsx           (new)
    │   └── MarkdownText.test.tsx         (new)
    ├── prompts/
    │   ├── PromptItem.test.tsx           (new)
    │   └── StatusIcon.test.tsx           (new)
    └── workflow/
        ├── WorkflowControls.test.tsx     (new)
        └── WorkflowStatus.test.tsx       (new)
```

---

## Coverage Targets

Suggested incremental targets to avoid overwhelming the team:

| Sprint | Focus | Target |
|--------|-------|--------|
| 1 | All `utils/` | 80% line coverage on utils/ |
| 2 | All `store/` | 70% line coverage on store/ |
| 3 | Critical hooks (`useMessageHandler`) | 60% line coverage on hooks/ |
| 4 | Shared + output components | 50% line coverage on components/ |
| Ongoing | CI enforcement | Thresholds added to `vitest.config.ts` |

---

## VS Code Integration Notes

- `@testing-library/user-event` v14 is already a dev dependency — use it for all
  interaction tests (it simulates real browser events, not just synthetic React ones).
- `jsdom` does not implement `ResizeObserver` or `matchMedia` — mock these in
  `test/setup.ts` using `vi.stubGlobal`.
- CodeMirror 6 (`@codemirror/view`) uses a canvas-like DOM API that jsdom does not
  support. Tests for `CodeMirrorEditor.tsx` may need to mock the CodeMirror instance
  entirely or use a lightweight stub editor.
- The `acquireVsCodeApi` mock in `test/setup.ts` already handles `postMessage` /
  `getState` / `setState`. Extend it with `vi.fn()` spies to assert specific calls.

---

## Quick Wins (start here)

1. **`npm run test:ui:coverage`** — run once now to see the baseline HTML report before
   any new tests are written.
2. **`utils/time.ts`** — simplest file, ~5 functions, zero dependencies. Good warm-up.
3. **`utils/string.ts`** — 86 lines, pure string functions, zero mocks needed.
4. **`store/settingsStore.ts`** — smallest store, clear message/action contract.
5. **`useMessageHandler` smoke test** — even a single `LOAD_WORKFLOW` dispatch test
   immediately guards the most critical integration path.
