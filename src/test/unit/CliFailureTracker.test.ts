import * as assert from "assert";
import { suite, test } from "mocha";
import { CliFailureTracker } from "../../core/harness/shared/CliFailureTracker";
import {
  FAILURE_KINDS,
  INTERACTIVE_ABORT_KINDS,
} from "../../types/DashboardConstants";

suite("CliFailureTracker", () => {
  test("should classify PTY exit as an interactive abort", () => {
    const tracker = new CliFailureTracker();

    tracker.capturePtyExit(0, []);

    assert.deepStrictEqual(tracker.getInteractiveAbortState(false), {
      kind: INTERACTIVE_ABORT_KINDS.PROCESS_EXITED,
      exitCode: 0,
    });
  });

  test("should mark startup process exit failures", () => {
    const tracker = new CliFailureTracker();

    const reason = tracker.markProcessExitDuringStage(
      "waiting for SessionStart hook",
      0
    );

    assert.strictEqual(
      reason,
      "CLI process exited unexpectedly while waiting for SessionStart hook (exit code 0)"
    );
    assert.strictEqual(tracker.wasLastFailureProcessExit(), true);
    assert.strictEqual(
      tracker.getLastFailureKind(),
      FAILURE_KINDS.PROCESS_EXIT
    );
    assert.strictEqual(tracker.getLastFailureMessage(), reason);
  });

  test("should track harness errors and timeouts separately", () => {
    const tracker = new CliFailureTracker();

    const harnessError = tracker.markHarnessError("Claude StopFailure");
    assert.strictEqual(harnessError, "Claude StopFailure");
    assert.strictEqual(tracker.wasLastFailureHarnessError(), true);
    assert.strictEqual(tracker.wasLastFailureTimeout(), false);
    assert.strictEqual(
      tracker.getLastFailureKind(),
      FAILURE_KINDS.HARNESS_ERROR
    );

    const timeout = tracker.markTimeout("Log monitoring timeout");
    assert.strictEqual(timeout, "Log monitoring timeout");
    assert.strictEqual(tracker.wasLastFailureHarnessError(), false);
    assert.strictEqual(tracker.wasLastFailureTimeout(), true);
    assert.strictEqual(tracker.getLastFailureKind(), FAILURE_KINDS.TIMEOUT);
    assert.strictEqual(tracker.getLastFailureMessage(), timeout);
  });

  test("should strip terminal control sequences from PTY output tail", () => {
    const tracker = new CliFailureTracker();

    tracker.capturePtyExit(0, [
      "\u001b[?9001h\u001b[?1004h\u001b[?25l\n",
      "\u001b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\u0007",
      "\u001b[?25herror: unknown option '--poopy'\n",
      "(Did you mean --prompt?)\n",
      "Try 'copilot --help' for more information.\n",
    ]);

    const tail = tracker.getLastFailureOutput();

    assert.strictEqual(
      tail,
      [
        "error: unknown option '--poopy'",
        "(Did you mean --prompt?)",
        "Try 'copilot --help' for more information.",
      ].join("\n")
    );
    assert.ok(!tail?.includes("\u001b"));
    assert.ok(!tail?.includes("\u0007"));
  });

  test("should reset captured failure state", () => {
    const tracker = new CliFailureTracker();

    tracker.capturePtyExit(1, ["error: boom\n"]);
    tracker.markCompletionDetectionProcessExit(1);
    tracker.reset();

    assert.strictEqual(tracker.getInteractiveAbortState(false), null);
    assert.strictEqual(tracker.wasLastFailureProcessExit(), false);
    assert.strictEqual(tracker.wasLastFailureHarnessError(), false);
    assert.strictEqual(tracker.wasLastFailureTimeout(), false);
    assert.strictEqual(tracker.getLastFailureOutput(), undefined);
    assert.strictEqual(tracker.getLastFailureKind(), undefined);
    assert.strictEqual(tracker.getLastFailureMessage(), undefined);
  });
});
