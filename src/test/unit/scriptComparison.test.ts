import * as assert from "assert";
import { suite, test } from "mocha";
import {
  MAX_REGEX_INPUT_LENGTH,
  compareScriptOutput,
  describeComparison,
  describeIncompleteComparison,
  formatComparison,
  formatComparisonSubject,
  isComparisonIncomplete,
  resolveReportedScriptProperties,
  resolveScriptComparison,
} from "../../utils/ScriptComparison";
import {
  COMPARE_SOURCES,
  DEFAULT_COMPARE_SOURCE,
  DEFAULT_SCRIPT_OPERATOR,
  SCRIPT_OPERATORS,
} from "../../types/DashboardConstants";
import { SCRIPT_OPERATOR_OPTIONS_META } from "../../types/SchemaUiMetadata";

/** A clean run that printed `stdout` and wrote nothing to stderr. */
function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
}

suite("ScriptComparison", () => {
  suite("defaults", () => {
    test("an unconfigured comparison is exit code 0", () => {
      const resolved = resolveScriptComparison({});
      assert.strictEqual(resolved.compareSource, COMPARE_SOURCES.EXIT_CODE);
      assert.strictEqual(resolved.operator, SCRIPT_OPERATORS.EQ);
      assert.strictEqual(resolved.expected, undefined);
      assert.strictEqual(resolved.ignoreCase, false);

      assert.strictEqual(compareScriptOutput({}, ok("anything")).passed, true);
      assert.strictEqual(
        compareScriptOutput({}, { stdout: "", stderr: "", exitCode: 1 }).passed,
        false
      );
    });

    test("an absent `expected` means exit 0 whatever the compare source says", () => {
      const config = { compareSource: COMPARE_SOURCES.STDOUT };
      assert.strictEqual(compareScriptOutput(config, ok("x")).passed, true);
      assert.strictEqual(
        compareScriptOutput(config, { stdout: "x", exitCode: 3 }).passed,
        false
      );
    });

    test("`true` is not a magic exit-code value", () => {
      assert.strictEqual(
        compareScriptOutput(
          { compareSource: COMPARE_SOURCES.EXIT_CODE, expected: "true" },
          ok("")
        ).passed,
        false
      );
    });

    test("a numeric `expected` needs no quoting", () => {
      assert.strictEqual(
        compareScriptOutput(
          { compareSource: COMPARE_SOURCES.EXIT_CODE, expected: 3 },
          { stdout: "", exitCode: 3 }
        ).passed,
        true
      );
      assert.strictEqual(
        resolveScriptComparison({ expected: 0 }).expected,
        "0"
      );
    });
  });

  suite("compare sources", () => {
    test("reads the requested stream and trims it", () => {
      const result = compareScriptOutput(
        { compareSource: COMPARE_SOURCES.STDOUT, expected: "value" },
        { stdout: "  value \n", stderr: "other", exitCode: 0 }
      );
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.actual, "value");
    });

    test("a text comparison does not also require a clean exit", () => {
      assert.strictEqual(
        compareScriptOutput(
          { compareSource: COMPARE_SOURCES.STDOUT, expected: "done" },
          { stdout: "done", exitCode: 1 }
        ).passed,
        true,
        "the author asked about stdout, so the exit code is not a second hidden condition"
      );
      assert.strictEqual(
        compareScriptOutput(
          { compareSource: COMPARE_SOURCES.STDERR, expected: "warn" },
          { stdout: "", stderr: "warn", exitCode: 1 }
        ).passed,
        true
      );
    });
  });

  suite("operators", () => {
    const stdout = (expected: string, operator?: string) => (value: string) =>
      compareScriptOutput(
        {
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: operator as never,
          expected,
        },
        ok(value)
      ).passed;

    test("eq compares the whole trimmed value; ne inverts it", () => {
      const isOk = stdout("ok");
      assert.strictEqual(isOk("ok"), true);
      assert.strictEqual(isOk("ok and more"), false);
      assert.strictEqual(stdout("ok", SCRIPT_OPERATORS.NE)("nope"), true);
    });

    test("contains and notContains test substrings", () => {
      assert.strictEqual(
        stdout("PASS", SCRIPT_OPERATORS.CONTAINS)("3 PASSED"),
        true
      );
      assert.strictEqual(
        stdout("FAIL", SCRIPT_OPERATORS.NOT_CONTAINS)("3 PASSED"),
        true
      );
    });

    test("numeric operators compare numbers", () => {
      assert.strictEqual(stdout("80", SCRIPT_OPERATORS.GTE)("92"), true);
      assert.strictEqual(stdout("80", SCRIPT_OPERATORS.GTE)("80"), true);
      assert.strictEqual(stdout("80", SCRIPT_OPERATORS.GT)("80"), false);
      assert.strictEqual(stdout("80", SCRIPT_OPERATORS.LTE)("80"), true);
      assert.strictEqual(stdout("80", SCRIPT_OPERATORS.LT)("79"), true);
    });

    test("a numeric operator fails on a non-numeric operand instead of degrading", () => {
      // The removed implementation fell through to a substring test here, which
      // is how `expected: 0` used to pass against "10 errors".
      assert.strictEqual(stdout("80", SCRIPT_OPERATORS.GTE)("none"), false);
      assert.strictEqual(stdout("80", SCRIPT_OPERATORS.GTE)(""), false);
      assert.strictEqual(stdout("none", SCRIPT_OPERATORS.GTE)("80"), false);
    });

    test("matches is an unanchored regex", () => {
      const anchored = stdout(
        "^\\d+ passing, 0 failing$",
        SCRIPT_OPERATORS.MATCHES
      );
      assert.strictEqual(anchored("12 passing, 0 failing"), true);
      assert.strictEqual(anchored("ran 12 passing, 0 failing"), false);
      assert.strictEqual(
        stdout(
          "\\d+ passing",
          SCRIPT_OPERATORS.MATCHES
        )("ran 12 passing, 3 failing"),
        true
      );
    });

    test("an invalid regex fails rather than throwing", () => {
      assert.strictEqual(
        stdout("([unclosed", SCRIPT_OPERATORS.MATCHES)("anything"),
        false
      );
    });

    test("a regex runs against a bounded slice of the output", () => {
      const huge = `${"a".repeat(MAX_REGEX_INPUT_LENGTH)}needle`;
      assert.strictEqual(
        stdout("needle", SCRIPT_OPERATORS.MATCHES)(huge),
        false,
        "output past the cap is not matched, so a pathological pattern cannot be fed unbounded input"
      );
    });

    test("isEmpty and isNotEmpty ignore `expected`", () => {
      assert.strictEqual(
        compareScriptOutput(
          {
            compareSource: COMPARE_SOURCES.STDOUT,
            operator: SCRIPT_OPERATORS.IS_EMPTY,
          },
          ok("   \n ")
        ).passed,
        true
      );
      assert.strictEqual(
        compareScriptOutput(
          {
            compareSource: COMPARE_SOURCES.STDOUT,
            operator: SCRIPT_OPERATORS.IS_NOT_EMPTY,
          },
          ok("lint output")
        ).passed,
        true
      );
    });
  });

  suite("ignoreCase", () => {
    test("text comparisons are case-sensitive by default", () => {
      const config = {
        compareSource: COMPARE_SOURCES.STDOUT,
        expected: "pass",
      };
      assert.strictEqual(compareScriptOutput(config, ok("PASS")).passed, false);
      assert.strictEqual(
        compareScriptOutput({ ...config, ignoreCase: true }, ok("PASS")).passed,
        true
      );
    });

    test("it does not apply to regex or numeric operators", () => {
      assert.strictEqual(
        compareScriptOutput(
          {
            compareSource: COMPARE_SOURCES.STDOUT,
            operator: SCRIPT_OPERATORS.MATCHES,
            expected: "pass",
            ignoreCase: true,
          },
          ok("PASS")
        ).passed,
        false,
        "a case-insensitive regex is spelled (?i) in the pattern, not with ignoreCase"
      );
    });
  });

  suite("regressions from the inferred-rule waterfall", () => {
    test("expecting 0 no longer passes on '10 errors'", () => {
      assert.strictEqual(
        compareScriptOutput(
          { compareSource: COMPARE_SOURCES.STDOUT, expected: 0 },
          ok("10 errors")
        ).passed,
        false
      );
    });

    test("expecting PASS no longer passes on '3 PASSED, 2 FAILED'", () => {
      assert.strictEqual(
        compareScriptOutput(
          { compareSource: COMPARE_SOURCES.STDOUT, expected: "PASS" },
          ok("3 PASSED, 2 FAILED")
        ).passed,
        false
      );
      assert.strictEqual(
        compareScriptOutput(
          {
            compareSource: COMPARE_SOURCES.STDOUT,
            operator: SCRIPT_OPERATORS.CONTAINS,
            expected: "PASS",
          },
          ok("3 PASSED, 2 FAILED")
        ).passed,
        true,
        "a substring match is still available — it just has to be asked for"
      );
    });

    test("a stdout value of 'false' no longer inverts a passing check", () => {
      // The boolean-synonym stage used to make this fail despite a clean exit.
      assert.strictEqual(compareScriptOutput({}, ok("false")).passed, true);
    });
  });

  suite("descriptions", () => {
    test("the default reads as success, never as a boolean", () => {
      const sentence = describeComparison({});
      assert.strictEqual(
        sentence,
        "Passes when the script exits with code 0.",
        "the phrase 'true' must never appear — that translation is what this design removed"
      );
      assert.ok(!/true/i.test(sentence));
    });

    test("a configured comparison names its source, operator, and value", () => {
      assert.strictEqual(
        describeComparison({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.CONTAINS,
          expected: "0 failing",
        }),
        'Passes when stdout contains "0 failing".'
      );
    });

    test("it warns that a numeric operator needs numbers and a regex is unanchored", () => {
      assert.match(
        describeComparison({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.GTE,
          expected: "80",
        }),
        /Both sides must be numeric/
      );
      assert.match(
        describeComparison({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.MATCHES,
          expected: "^ok$",
        }),
        /unanchored/
      );
    });

    test("it mentions ignoreCase only where it applies", () => {
      assert.match(
        describeComparison({
          compareSource: COMPARE_SOURCES.STDOUT,
          expected: "pass",
          ignoreCase: true,
        }),
        /ignoring case/
      );
      assert.doesNotMatch(
        describeComparison({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.GTE,
          expected: "80",
          ignoreCase: true,
        }),
        /ignoring case/
      );
    });

    test("the compact forms use the symbolic operator labels", () => {
      assert.strictEqual(
        formatComparison({
          compareSource: COMPARE_SOURCES.EXIT_CODE,
          expected: 0,
        }),
        `exit code ${SCRIPT_OPERATOR_OPTIONS_META.eq.label.toLowerCase()} 0`
      );
      assert.strictEqual(
        formatComparison({}),
        "exit code == 0",
        "an unset comparison still renders its own defaults"
      );
      assert.strictEqual(
        formatComparisonSubject({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.CONTAINS,
        }),
        "stdout contains"
      );
      assert.strictEqual(
        formatComparison({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.IS_EMPTY,
        }),
        "stdout is empty",
        "a valueless operator prints no value"
      );
      assert.strictEqual(
        formatComparison({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.CONTAINS,
        }),
        "exit code == 0",
        "without `expected` the exit-code fallback runs, so that is what prints"
      );
    });
  });

  suite("isComparisonIncomplete", () => {
    test("flags a stated comparison that has no value to apply", () => {
      assert.strictEqual(
        isComparisonIncomplete({ compareSource: COMPARE_SOURCES.STDOUT }),
        true
      );
      assert.strictEqual(
        isComparisonIncomplete({ operator: SCRIPT_OPERATORS.CONTAINS }),
        true
      );
      assert.match(
        describeIncompleteComparison({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.CONTAINS,
        }),
        /"stdout contains" is ignored/
      );
    });

    test("leaves the untouched default alone — it already means exit code 0", () => {
      assert.strictEqual(isComparisonIncomplete({}), false);
      assert.strictEqual(
        isComparisonIncomplete({
          compareSource: DEFAULT_COMPARE_SOURCE,
          operator: DEFAULT_SCRIPT_OPERATOR,
        }),
        false
      );
    });

    test("a value, or an operator that needs none, completes the comparison", () => {
      assert.strictEqual(
        isComparisonIncomplete({
          compareSource: COMPARE_SOURCES.STDOUT,
          expected: "0 failing",
        }),
        false
      );
      assert.strictEqual(
        isComparisonIncomplete({
          compareSource: COMPARE_SOURCES.STDOUT,
          expected: 0,
        }),
        false,
        "a numeric 0 is a value, not an absent one"
      );
      assert.strictEqual(
        isComparisonIncomplete({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.IS_EMPTY,
        }),
        false
      );
    });
  });

  suite("resolveReportedScriptProperties", () => {
    test("fills the defaults and normalizes `expected` to a string", () => {
      const resolved = resolveReportedScriptProperties({
        script: "npm test",
        expected: 3,
      });
      assert.strictEqual(resolved.compareSource, DEFAULT_COMPARE_SOURCE);
      assert.strictEqual(resolved.operator, DEFAULT_SCRIPT_OPERATOR);
      assert.strictEqual(resolved.expected, "3");
      assert.strictEqual(resolved.script, "npm test");
    });

    test("omits `expected` entirely when it was never set", () => {
      const resolved = resolveReportedScriptProperties({
        script: "npm test",
        expected: undefined,
      });
      assert.ok(
        !("expected" in resolved),
        "an explicit undefined would serialize an empty comparison into run storage"
      );
    });
  });
});
