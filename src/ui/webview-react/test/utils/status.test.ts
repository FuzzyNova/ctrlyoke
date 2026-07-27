import { describe, it, expect } from "vitest";
import {
  getStatusIconClass,
  getStatusIconClassName,
  getStatusColorClass,
  getStatusLabel,
  getExecutionStateIconClass,
  getExecutionStateColorClass,
  getExecutionStateLabel,
  getExecutionStateBadgeClass,
  getWorkflowExecutionControls,
  isExecutionBusy,
  canStartExecution,
  canPauseExecution,
  canResumeExecution,
  canStopExecution,
  STATUS_ICONS,
  STATUS_COLORS,
  getStepAccentClass,
} from "@utils/status";
import { STEP_STATUS, EXECUTION_STATES } from "@/types/messages";

describe("getStatusIconClass", () => {
  it("returns icon for every STEP_STATUS value", () => {
    for (const status of Object.values(STEP_STATUS)) {
      expect(getStatusIconClass(status)).toBeTruthy();
    }
  });

  it("returns pending icon for unknown status", () => {
    expect(getStatusIconClass("unknown" as never)).toBe(
      STATUS_ICONS[STEP_STATUS.PENDING]
    );
  });
});

describe("getStatusIconClassName", () => {
  it("includes base codicon class", () => {
    const cls = getStatusIconClassName(STEP_STATUS.COMPLETED);
    expect(cls).toMatch(/^codicon /);
    expect(cls).toContain("codicon-pass");
  });
});

describe("getStatusColorClass", () => {
  it("returns a color class for every STEP_STATUS value", () => {
    for (const status of Object.values(STEP_STATUS)) {
      expect(getStatusColorClass(status)).toBeTruthy();
    }
  });

  it("returns pending color for unknown status", () => {
    expect(getStatusColorClass("unknown" as never)).toBe(
      STATUS_COLORS[STEP_STATUS.PENDING]
    );
  });
});

describe("getStatusLabel", () => {
  it.each([
    [STEP_STATUS.PENDING, "Pending"],
    [STEP_STATUS.RUNNING, "Running"],
    [STEP_STATUS.COMPLETED, "Completed"],
    [STEP_STATUS.FAILED, "Failed"],
    [STEP_STATUS.CANCELLED, "Cancelled"],
    [STEP_STATUS.SKIPPED, "Skipped"],
  ])("maps %s → %s", (status, label) => {
    expect(getStatusLabel(status)).toBe(label);
  });

  it('returns "Unknown" for unrecognised status', () => {
    expect(getStatusLabel("mystery" as never)).toBe("Unknown");
  });
});

describe("getStepAccentClass", () => {
  it("uses warning accents for cancelled and skipped steps", () => {
    expect(getStepAccentClass(STEP_STATUS.CANCELLED)).toBe(
      "bg-indicator-running"
    );
    expect(getStepAccentClass(STEP_STATUS.SKIPPED)).toBe(
      "bg-indicator-running"
    );
  });

  it("uses error accents for failed steps", () => {
    expect(getStepAccentClass(STEP_STATUS.FAILED)).toBe("bg-indicator-error");
  });
});

describe("getExecutionStateIconClass", () => {
  it("returns an icon for every EXECUTION_STATES value", () => {
    for (const state of Object.values(EXECUTION_STATES)) {
      expect(getExecutionStateIconClass(state)).toBeTruthy();
    }
  });
});

describe("getExecutionStateColorClass", () => {
  it("returns a color class for every EXECUTION_STATES value", () => {
    for (const state of Object.values(EXECUTION_STATES)) {
      expect(getExecutionStateColorClass(state)).toBeTruthy();
    }
  });
});

describe("getExecutionStateLabel", () => {
  it.each([
    [EXECUTION_STATES.IDLE, "Ready"],
    [EXECUTION_STATES.RUNNING, "Running"],
    [EXECUTION_STATES.PAUSING, "Pausing..."],
    [EXECUTION_STATES.PAUSED, "Paused"],
    [EXECUTION_STATES.STOPPED, "Stopped"],
    [EXECUTION_STATES.COMPLETED, "Completed"],
    [EXECUTION_STATES.ERROR, "Error"],
  ])("maps %s → %s", (state, label) => {
    expect(getExecutionStateLabel(state)).toBe(label);
  });
});

describe("getExecutionStateBadgeClass", () => {
  it("returns a badge class for known states", () => {
    expect(getExecutionStateBadgeClass("running")).toBeTruthy();
    expect(getExecutionStateBadgeClass("completed")).toBeTruthy();
  });

  it("is case-insensitive", () => {
    expect(getExecutionStateBadgeClass("RUNNING")).toBe(
      getExecutionStateBadgeClass("running")
    );
  });

  it("falls back to idle class for unknown state", () => {
    const fallback = getExecutionStateBadgeClass("idle");
    expect(getExecutionStateBadgeClass("unknown-state")).toBe(fallback);
  });
});

describe("isExecutionBusy", () => {
  it("is true when running", () => {
    expect(isExecutionBusy(EXECUTION_STATES.RUNNING)).toBe(true);
  });

  it("is true when pausing", () => {
    expect(isExecutionBusy(EXECUTION_STATES.PAUSING)).toBe(true);
  });

  it("is true when cancelling", () => {
    expect(isExecutionBusy(EXECUTION_STATES.CANCELLING)).toBe(true);
  });

  it("is false for all other states", () => {
    const nonBusy = [
      EXECUTION_STATES.IDLE,
      EXECUTION_STATES.PAUSED,
      EXECUTION_STATES.STOPPED,
      EXECUTION_STATES.COMPLETED,
      EXECUTION_STATES.ERROR,
    ];
    for (const state of nonBusy) {
      expect(isExecutionBusy(state)).toBe(false);
    }
  });
});

describe("canStartExecution", () => {
  it("allows start from idle, completed, error, stopped", () => {
    expect(canStartExecution(EXECUTION_STATES.IDLE)).toBe(true);
    expect(canStartExecution(EXECUTION_STATES.COMPLETED)).toBe(true);
    expect(canStartExecution(EXECUTION_STATES.ERROR)).toBe(true);
    expect(canStartExecution(EXECUTION_STATES.STOPPED)).toBe(true);
  });

  it("disallows start from running, pausing, or paused", () => {
    expect(canStartExecution(EXECUTION_STATES.RUNNING)).toBe(false);
    expect(canStartExecution(EXECUTION_STATES.PAUSING)).toBe(false);
    expect(canStartExecution(EXECUTION_STATES.PAUSED)).toBe(false);
  });
});

describe("canPauseExecution", () => {
  it("allows pause only when running", () => {
    expect(canPauseExecution(EXECUTION_STATES.RUNNING)).toBe(true);
    expect(canPauseExecution(EXECUTION_STATES.PAUSED)).toBe(false);
    expect(canPauseExecution(EXECUTION_STATES.IDLE)).toBe(false);
  });
});

describe("canResumeExecution", () => {
  it("allows resume only when paused", () => {
    expect(canResumeExecution(EXECUTION_STATES.PAUSED)).toBe(true);
    expect(canResumeExecution(EXECUTION_STATES.RUNNING)).toBe(false);
    expect(canResumeExecution(EXECUTION_STATES.IDLE)).toBe(false);
  });
});

describe("canStopExecution", () => {
  it("allows stop when running, pausing, or paused", () => {
    expect(canStopExecution(EXECUTION_STATES.RUNNING)).toBe(true);
    expect(canStopExecution(EXECUTION_STATES.PAUSING)).toBe(true);
    expect(canStopExecution(EXECUTION_STATES.PAUSED)).toBe(true);
  });

  it("disallows stop from idle, completed, error, stopped", () => {
    expect(canStopExecution(EXECUTION_STATES.IDLE)).toBe(false);
    expect(canStopExecution(EXECUTION_STATES.COMPLETED)).toBe(false);
    expect(canStopExecution(EXECUTION_STATES.ERROR)).toBe(false);
    expect(canStopExecution(EXECUTION_STATES.STOPPED)).toBe(false);
  });
});

describe("getWorkflowExecutionControls", () => {
  const getControls = (
    executionState: (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES],
    overrides: {
      viewedKind?: "draft" | "run" | null;
      hasFile?: boolean;
      hasSteps?: boolean;
      pendingRewind?: boolean;
      executionRunState?: (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];
      executionRunLabel?: string;
      viewedRunUnstarted?: boolean;
    } = {}
  ) =>
    getWorkflowExecutionControls({
      viewedExecutionState: executionState,
      viewedKind: overrides.viewedKind ?? "run",
      hasFile: overrides.hasFile ?? true,
      hasSteps: overrides.hasSteps ?? true,
      pendingRewind: overrides.pendingRewind ?? false,
      executionRunState: overrides.executionRunState,
      executionRunLabel: overrides.executionRunLabel,
      viewedRunUnstarted: overrides.viewedRunUnstarted,
    });

  it("uses slot 1 Run for a draft", () => {
    const controls = getControls(EXECUTION_STATES.IDLE, {
      viewedKind: "draft",
    });
    expect(controls.slot1).toMatchObject({
      action: "run-draft",
      label: "Run",
      enabled: true,
    });
    expect(controls.slot2).toMatchObject({
      label: "Pause",
      icon: "codicon-debug-pause",
      enabled: false,
    });
    expect(controls.slot3.enabled).toBe(false);
  });

  it("disables all execution slots for an empty draft", () => {
    const controls = getControls(EXECUTION_STATES.IDLE, {
      viewedKind: "draft",
      hasSteps: false,
    });
    expect(controls.slot1).toMatchObject({ label: "Run", enabled: false });
    expect(controls.slot1.title).toBe("Add steps to run");
    expect(controls.slot2.enabled).toBe(false);
    expect(controls.slot3.enabled).toBe(false);
  });

  it("trusts an addressed run while its definition is still loading", () => {
    const controls = getControls(EXECUTION_STATES.COMPLETED, {
      viewedKind: "run",
      hasFile: false,
      hasSteps: false,
    });
    expect(controls.slot1).toMatchObject({
      action: "rerun",
      label: "Re-run",
      enabled: true,
    });
  });

  it("falls back to a disabled Pause when there is nothing to resume", () => {
    for (const controls of [
      getControls(EXECUTION_STATES.IDLE),
      getControls(EXECUTION_STATES.COMPLETED),
      getControls(EXECUTION_STATES.IDLE, { hasFile: false, viewedKind: null }),
    ]) {
      expect(controls.slot2).toMatchObject({
        action: "none",
        label: "Pause",
        icon: "codicon-debug-pause",
        enabled: false,
      });
    }
  });

  it("uses slot 1 Re-run for an idle or completed promoted run", () => {
    for (const state of [
      EXECUTION_STATES.IDLE,
      EXECUTION_STATES.COMPLETED,
    ] as const) {
      expect(getControls(state).slot1).toMatchObject({
        action: "rerun",
        label: "Re-run",
        icon: "codicon-refresh",
        enabled: true,
      });
    }
  });

  it("uses slot 1 Run for a seeded run that has never executed", () => {
    const controls = getControls(EXECUTION_STATES.IDLE, {
      viewedRunUnstarted: true,
    });
    expect(controls.slot1).toMatchObject({
      action: "start-run",
      label: "Run",
      icon: "codicon-debug-start",
      enabled: true,
    });
    expect(controls.slot2.enabled).toBe(false);
    expect(controls.slot3.enabled).toBe(false);
  });

  // An addressed run whose definition has not arrived yet reads as "no steps".
  // Run would be a lie there — the client has nothing to run — so the unstarted
  // affordance must not fire until the definition is on screen.
  it("keeps Re-run for an unstarted run whose definition is still loading", () => {
    expect(
      getControls(EXECUTION_STATES.IDLE, {
        viewedRunUnstarted: true,
        hasSteps: false,
        hasFile: false,
      }).slot1
    ).toMatchObject({ action: "rerun", label: "Re-run" });
  });

  it("labels the disabled slot 1 Run for an unstarted run while another run executes", () => {
    const controls = getControls(EXECUTION_STATES.IDLE, {
      viewedRunUnstarted: true,
      executionRunState: EXECUTION_STATES.RUNNING,
    });
    expect(controls.slot1).toMatchObject({ label: "Run", enabled: false });
    expect(controls.slot2.action).toBe("pause");
  });

  it("uses slot 2 Resume only for resumable promoted work", () => {
    const controls = getControls(EXECUTION_STATES.STOPPED);
    expect(controls.slot1.action).toBe("rerun");
    expect(controls.slot2).toMatchObject({
      action: "resume",
      label: "Resume",
      enabled: true,
    });
  });

  it("uses slot 1 Restart and slot 2 Continue during a pending rewind", () => {
    const controls = getControls(EXECUTION_STATES.IDLE, {
      pendingRewind: true,
    });
    expect(controls.slot1).toMatchObject({
      action: "restart",
      label: "Restart",
      enabled: true,
    });
    expect(controls.slot2).toMatchObject({
      action: "continue",
      label: "Continue",
      enabled: true,
    });
  });

  it("prefers Continue over Resume during a pending rewind on a stopped run", () => {
    const controls = getControls(EXECUTION_STATES.STOPPED, {
      pendingRewind: true,
    });
    expect(controls.slot1.action).toBe("restart");
    expect(controls.slot2).toMatchObject({
      action: "continue",
      label: "Continue",
      enabled: true,
    });
  });

  it("keeps all three slots while executing and targets the execution label", () => {
    const controls = getControls(EXECUTION_STATES.IDLE, {
      executionRunState: EXECUTION_STATES.RUNNING,
      executionRunLabel: "run 9",
    });
    expect(controls.slot1.enabled).toBe(false);
    expect(controls.slot2).toMatchObject({ action: "pause", enabled: true });
    expect(controls.slot2.title).toContain("run 9");
    expect(controls.slot3).toMatchObject({ action: "stop", enabled: true });
  });

  it("keeps pause cancellation and stop in slots 2 and 3", () => {
    const controls = getControls(EXECUTION_STATES.IDLE, {
      executionRunState: EXECUTION_STATES.PAUSING,
    });
    expect(controls.slot2.action).toBe("cancel-pause");
    expect(controls.slot3.action).toBe("stop");
  });

  // The executing run's state can only be read from a summary, and the
  // addressed `runSummaries` snapshot is frozen at the last RUN_VIEW_LOADED —
  // a run seeded and started in one gesture leaves it reading "idle" for the
  // whole run. Letting that stale value win reported "nothing is executing"
  // over the live viewed state.
  it("ignores a non-active executionRunState in favour of the live viewed state", () => {
    for (const stale of [
      EXECUTION_STATES.IDLE,
      EXECUTION_STATES.COMPLETED,
      EXECUTION_STATES.STOPPED,
    ] as const) {
      const pausing = getControls(EXECUTION_STATES.PAUSING, {
        executionRunState: stale,
      });
      expect(pausing.isPausing).toBe(true);
      expect(pausing.slot2).toMatchObject({
        action: "cancel-pause",
        enabled: true,
      });
      expect(pausing.slot3).toMatchObject({ action: "stop", enabled: true });

      const paused = getControls(EXECUTION_STATES.PAUSED, {
        executionRunState: stale,
      });
      expect(paused.isPaused).toBe(true);
      expect(paused.slot2).toMatchObject({ action: "resume", enabled: true });
      expect(paused.slot3).toMatchObject({ action: "stop", enabled: true });
    }
  });

  it("still prefers an active executionRunState over the viewed run's state", () => {
    const controls = getControls(EXECUTION_STATES.COMPLETED, {
      executionRunState: EXECUTION_STATES.PAUSED,
      executionRunLabel: "run 4",
    });
    expect(controls.isPaused).toBe(true);
    expect(controls.slot2).toMatchObject({ action: "resume", enabled: true });
    expect(controls.slot2.title).toContain("run 4");
  });
});
