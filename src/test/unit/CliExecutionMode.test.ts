import * as assert from "assert";
import { suite, test } from "mocha";
import { EXECUTION_MODES } from "../../types/DashboardConstants";
import { resolveCliExecutionMode } from "../../cli/CliExecutionMode";

suite("CliExecutionMode", () => {
  test("TTYs set the default mode and PTY capability", () => {
    assert.deepStrictEqual(resolveCliExecutionMode(true, true), {
      executionMode: EXECUTION_MODES.INTERACTIVE,
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: false,
    });
  });

  test("both missing TTYs set the headless default and disable PTY", () => {
    assert.deepStrictEqual(resolveCliExecutionMode(false, false), {
      executionMode: EXECUTION_MODES.HEADLESS,
      hostCanProvidePty: false,
      supportsConcurrentInteractiveSessions: false,
    });
  });

  test("no TTY clamps workflow modes by disabling the PTY capability", () => {
    const resolved = resolveCliExecutionMode(true, false);

    assert.strictEqual(resolved.executionMode, EXECUTION_MODES.HEADLESS);
    assert.strictEqual(resolved.hostCanProvidePty, false);
    assert.strictEqual(resolved.supportsConcurrentInteractiveSessions, false);
    assert.notStrictEqual(resolved.executionMode, EXECUTION_MODES.INTERACTIVE);
  });

  test("a TTY on both streams preserves workflow modes", () => {
    assert.deepStrictEqual(resolveCliExecutionMode(true, true), {
      executionMode: EXECUTION_MODES.INTERACTIVE,
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: false,
    });
  });
});
