/**
 * Dashboard mount smoke gate.
 *
 * Every other UI test renders one component with its heavy hooks mocked, which
 * is exactly why a React #185 crash (infinite `useSyncExternalStore` re-render
 * from an unstable zustand selector) can ship with `npm test` green: the loop
 * only exists when the *real* hook meets the *real* store in the *real* tree.
 *
 * This file mounts the whole `App` with nothing mocked, once per representative
 * store state, and fails on any error the top-level boundary catches. The
 * failure message carries the message plus the source-mapped component stack,
 * so a fix can start from the component name rather than a minified frame.
 *
 * Adding coverage: append a scenario whose seeded state opens a branch of the
 * tree the existing ones don't (a new panel, drawer, or execution phase).
 * Scenarios are cheap — the module graph is only imported once per file.
 * Seeding stores directly is deliberate shorthand for the state a
 * `RUN_VIEW_LOADED` would produce; if a scenario needs message-driven fidelity,
 * dispatch real `MESSAGE_TYPES` events instead (see `useMessageHandler.test.ts`).
 */
import { StrictMode, Component, type ErrorInfo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import App from "@/App";
import { useSettingsStore } from "@store/settingsStore";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useCompatibilityStore } from "@store/compatibilityStore";
import { EXECUTION_STATES, FINAL_STEP_PHASES } from "@/types/messages";
import {
  OutputUndoDialogs,
  type WorkflowDialogState,
} from "@components/layout/output-section/OutputUndoDialogs";

/**
 * React reports these by console.error rather than by throwing, or throws only
 * after many wasted renders. Treat them as crashes too — each one means a hook
 * or selector is unstable, which is the same defect class as #185.
 */
const FATAL_CONSOLE_PATTERNS = [
  "Maximum update depth exceeded",
  "getSnapshot should be cached",
  "Rendered more hooks than during the previous render",
  "Cannot update a component",
  "Should have a queue",
];

interface CaughtCrash {
  message: string;
  componentStack: string;
}

let caughtCrash: CaughtCrash | null = null;
let consoleErrors: string[] = [];

/**
 * Records what the real `ErrorBoundary` would log, then renders nothing so the
 * failed subtree is not retried (a boundary that re-renders its children after
 * a crash loops on exactly the bugs this file exists to catch).
 */
class CrashCapture extends Component<
  { children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    caughtCrash = {
      message: error.message,
      componentStack: info.componentStack ?? "(no component stack)",
    };
  }

  render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}

const RUN_ADDRESS = {
  workflowKey: "wf-smoke" as never,
  kind: "run" as const,
  runRef: "run-2026-01-01T00-00-00-000Z" as never,
};

const RUN_SUMMARY = {
  workflowKey: RUN_ADDRESS.workflowKey,
  runRef: RUN_ADDRESS.runRef,
  runDirectory: "/runs/wf-smoke/run",
  runId: 3,
  startedAt: 1_700_000_000_000,
  executionState: EXECUTION_STATES.COMPLETED,
  definitionRevision: 1,
  stepCount: 2,
  hasMixedHarnesses: false,
  hasMixedModels: false,
} as never;

/** Seeds the client state a run-addressed client holds after `RUN_VIEW_LOADED`. */
function seedDisplayedRun(overrides: Record<string, unknown> = {}): void {
  useUiStore.setState({
    displayedViewAddress: RUN_ADDRESS,
    appliedViewAddress: RUN_ADDRESS,
    runSummaries: [RUN_SUMMARY],
    executionRunRef: RUN_ADDRESS.runRef,
    activeWorkflowId: "inst-smoke",
    ...overrides,
  });
}

function resetStores(): void {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useTerminalStore.setState({ sessions: {}, activeSessionIds: {} });
}

/** Reports the crash and its component stack as the assertion's own message. */
function mountDashboard(scenario: string, extra?: ReactNode): void {
  render(
    <StrictMode>
      <CrashCapture>
        <App />
        {extra}
      </CrashCapture>
    </StrictMode>
  );

  const fatalConsoleErrors = consoleErrors.filter((line) =>
    FATAL_CONSOLE_PATTERNS.some((pattern) => line.includes(pattern))
  );
  const failure = caughtCrash
    ? `${scenario} crashed: ${caughtCrash.message}\n` +
      `Component stack:${caughtCrash.componentStack}`
    : fatalConsoleErrors.length > 0
      ? `${scenario} logged a fatal React error:\n${fatalConsoleErrors.join("\n")}`
      : null;

  expect(failure).toBeNull();
}

describe("dashboard mount smoke", () => {
  beforeEach(() => {
    caughtCrash = null;
    consoleErrors = [];
    // Captured rather than silenced: React reports some unstable-hook defects
    // only through console.error, and those must fail the test too.
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map((arg) => String(arg)).join(" "));
    });
    resetStores();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mounts cold with no workflow loaded", () => {
    mountDashboard("cold mount");
  });

  it("mounts with a run addressed and executing", () => {
    seedDisplayedRun();
    useWorkflowStore.setState({
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      totalSteps: 2,
    });

    mountDashboard("running run mount");
  });

  it("mounts while viewing a historical run", () => {
    seedDisplayedRun({ isViewingHistory: true });

    mountDashboard("history mount");
  });

  it("mounts the mobile layout", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as typeof window.matchMedia;
    seedDisplayedRun();

    mountDashboard("mobile mount");
  });

  it("mounts with the settings drawer and editor open", () => {
    seedDisplayedRun();
    useUiStore.setState({ globalSettingsOpen: true, editorCollapsed: false });

    mountDashboard("settings drawer mount");
  });

  it("mounts the workflow portability report surface", () => {
    useUiStore.setState({ workflowPortabilityReportOpen: true });
    mountDashboard("workflow portability report mount");
    expect(useCompatibilityStore.getState().capabilitySnapshotStatus).toBe(
      "checking"
    );
  });

  it("mounts a large undo dialog through the real component tree", () => {
    const entries: WorkflowDialogState["entries"] = Array.from(
      { length: 100 },
      (_unused, stepIndex) => ({
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
        label: `Prompt ${stepIndex + 1}`,
        undoCandidates: [
          {
            path: `src/file-${stepIndex}.ts`,
            changeType: "modified" as const,
            tier: "tier1" as const,
            oldContent: "before\n",
            newContent: "after\n",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-before", "+after"],
              },
            ],
            instruction: {
              path: `src/file-${stepIndex}.ts`,
              action: "reverse-patch" as const,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-before", "+after"],
                },
              ],
            },
          },
        ],
      })
    );
    const workflowDialogState: WorkflowDialogState = {
      mode: "undo",
      address: RUN_ADDRESS,
      entries,
      requestId: "large-undo-dialog-smoke",
    };

    seedDisplayedRun();
    mountDashboard(
      "large undo dialog mount",
      <OutputUndoDialogs
        minimapDialogState={null}
        workflowDialogState={workflowDialogState}
        onCloseMinimapDialog={vi.fn()}
        onCloseWorkflowDialog={vi.fn()}
      />
    );
  });
});
