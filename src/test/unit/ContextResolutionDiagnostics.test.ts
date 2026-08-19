import * as assert from "assert";
import { suite, test } from "mocha";
import {
  formatContextResolutionFailureMessage,
  isContextResolutionDiagnostic,
  PROMPT_DIAGNOSTIC_CODES,
} from "../../types/DashboardConstants";

suite("Context resolution diagnostics", () => {
  test("identifies only diagnostics that describe failed resolution", () => {
    const blockingCodes = [
      PROMPT_DIAGNOSTIC_CODES.UNKNOWN_SKILL_REFERENCE,
      PROMPT_DIAGNOSTIC_CODES.UNKNOWN_SECRET_REFERENCE,
      PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE,
      PROMPT_DIAGNOSTIC_CODES.UNKNOWN_MCP_REFERENCE,
    ];
    const advisoryCodes = [
      PROMPT_DIAGNOSTIC_CODES.LARGE_REFERENCE,
      PROMPT_DIAGNOSTIC_CODES.OVER_INLINE_CAP,
      PROMPT_DIAGNOSTIC_CODES.SOURCE_RUNTIME_DISCLOSURE,
      PROMPT_DIAGNOSTIC_CODES.CONDITION_OUTPUT_UNAVAILABLE,
    ];

    assert.ok(
      blockingCodes.every((code) => isContextResolutionDiagnostic(code))
    );
    assert.ok(
      advisoryCodes.every((code) => !isContextResolutionDiagnostic(code))
    );
    assert.strictEqual(
      isContextResolutionDiagnostic("other.diagnostic"),
      false
    );
  });

  test("formats multiple blocking diagnostics as newline-bulleted messages", () => {
    assert.strictEqual(
      formatContextResolutionFailureMessage([
        {
          message:
            'Skill "foo" referenced by /skill:foo was not found among discovered skills.',
        },
        {
          message:
            'Reference "~abc1234" could not be attached: unknown commit.',
        },
      ]),
      'Step blocked by execution.strictContextResolution="fail" — 2 references did not resolve:\n' +
        '  • Skill "foo" referenced by /skill:foo was not found among discovered skills.\n' +
        '  • Reference "~abc1234" could not be attached: unknown commit.'
    );
  });
});
