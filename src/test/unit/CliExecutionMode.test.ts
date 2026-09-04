import * as assert from "assert";
import { suite, test } from "mocha";
import { EXECUTION_MODES } from "../../types/DashboardConstants";
import { resolveCliExecutionMode } from "../../cli/CliExecutionMode";

const options = (
  overrides: {
    headless?: boolean;
    interactive?: boolean;
  } = {}
): {
  headless?: boolean;
  interactive?: boolean;
} => overrides;

suite("CliExecutionMode", () => {
  test("--headless disables the PTY capability even when both streams are TTYs", () => {
    assert.deepStrictEqual(
      resolveCliExecutionMode(options({ headless: true }), true, true),
      {
        executionMode: EXECUTION_MODES.HEADLESS,
        hostCanProvidePty: false,
        supportsConcurrentInteractiveSessions: false,
      }
    );
  });

  test("--interactive preserves workflow modes and enables the PTY capability", () => {
    assert.deepStrictEqual(
      resolveCliExecutionMode(options({ interactive: true }), false, false),
      {
        executionMode: EXECUTION_MODES.INTERACTIVE,
        hostCanProvidePty: true,
        supportsConcurrentInteractiveSessions: false,
      }
    );
  });

  test("no TTY clamps workflow modes by disabling the PTY capability", () => {
    const resolved = resolveCliExecutionMode(options(), true, false);

    assert.strictEqual(resolved.executionMode, EXECUTION_MODES.HEADLESS);
    assert.strictEqual(resolved.hostCanProvidePty, false);
    assert.strictEqual(
      resolved.supportsConcurrentInteractiveSessions,
      false
    );
    assert.notStrictEqual(resolved.executionMode, EXECUTION_MODES.INTERACTIVE);
  });

  test("a TTY on both streams preserves workflow modes", () => {
    assert.deepStrictEqual(resolveCliExecutionMode(options(), true, true), {
      executionMode: EXECUTION_MODES.INTERACTIVE,
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: false,
    });
  });
});
