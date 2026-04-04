import * as assert from "assert";
import { suite, test } from "mocha";
import { CliFailureTracker } from "../../flightpath/harness/shared/CliFailureTracker";
import { INTERACTIVE_ABORT_KINDS } from "../../types/DashboardConstants";

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
    assert.strictEqual(tracker.getLastFailureOutput(), undefined);
  });
});
