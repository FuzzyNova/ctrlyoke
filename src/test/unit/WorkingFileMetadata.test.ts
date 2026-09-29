import * as assert from "assert";
import type { WorkingFile } from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import {
  getWorkingFileLastActivityAt,
  resolveLineageLastModifiedAt,
} from "../../utils/WorkingFileMetadata";

function workingFile(overrides: Partial<WorkingFile> = {}): WorkingFile {
  return {
    definitionRevision: 1,
    startedAt: 100,
    steps: [],
    ...overrides,
  } as WorkingFile;
}

suite("WorkingFileMetadata", () => {
  suite("getWorkingFileLastActivityAt", () => {
    test("falls back to the run's startedAt when nothing has executed", () => {
      assert.strictEqual(getWorkingFileLastActivityAt(workingFile()), 100);
    });

    test("uses the newest run, step, and final-step timestamp", () => {
      const file = workingFile({
        steps: [
          { prompt: "a", _runtime: { startedAt: 200, completedAt: 300 } },
          { prompt: "b", _runtime: { startedAt: 900 } },
          { prompt: "c" },
        ] as WorkingFile["steps"],
        _runtime: {
          currentIndex: 1,
          executionState: EXECUTION_STATES.RUNNING,
          startTime: 150,
          finalStep: {
            phase: FINAL_STEP_PHASES.FINAL_STEP,
            loopCount: 0,
            completedAt: 400,
          },
        } as WorkingFile["_runtime"],
      });
      assert.strictEqual(getWorkingFileLastActivityAt(file), 900);
    });

    test("counts a terminal executionEndTime", () => {
      const file = workingFile({
        _runtime: {
          currentIndex: 0,
          executionState: EXECUTION_STATES.COMPLETED,
          executionEndTime: 5_000,
        } as WorkingFile["_runtime"],
      });
      assert.strictEqual(getWorkingFileLastActivityAt(file), 5_000);
    });
  });

  suite("resolveLineageLastModifiedAt", () => {
    test("keeps the descriptor timestamp when it is newest", () => {
      assert.strictEqual(resolveLineageLastModifiedAt(1_000, 500), 1_000);
    });

    test("prefers newer run activity over a stale descriptor", () => {
      assert.strictEqual(
        resolveLineageLastModifiedAt(1_000, undefined, 2_000),
        2_000
      );
    });

    test("returns 0 when nothing is known", () => {
      assert.strictEqual(resolveLineageLastModifiedAt(undefined), 0);
    });
  });
});
