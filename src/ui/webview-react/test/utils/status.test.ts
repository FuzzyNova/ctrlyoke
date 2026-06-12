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
