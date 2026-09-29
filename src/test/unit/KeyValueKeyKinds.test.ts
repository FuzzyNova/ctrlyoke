import * as assert from "assert";
import { COMPATIBILITY_DIAGNOSTIC_SEVERITIES } from "../../types/DashboardConstants";
import {
  KEY_VALUE_KEY_KINDS,
  validateKeyValueKey,
} from "../../utils/KeyValueKeyKinds";

suite("KeyValueKeyKinds", () => {
  test("rejects hyphenated variable names and suggests an underscore", () => {
    const diagnostics = validateKeyValueKey(
      KEY_VALUE_KEY_KINDS.VARIABLE,
      "my-var",
      ["my-var"]
    );

    assert.deepStrictEqual(diagnostics, [
      {
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR,
        message: 'Variable names must match ^\\w+$; use "my_var" instead.',
      },
    ]);
  });

  test("rejects variable names that differ only by case with parser wording", () => {
    const diagnostics = validateKeyValueKey(
      KEY_VALUE_KEY_KINDS.VARIABLE,
      "region",
      ["region", "REGION"]
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(
      diagnostics[0].severity,
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
    );
    assert.strictEqual(
      diagnostics[0].message,
      'Variable names must not differ only by case ("region")'
    );
  });

  test("validates env names and conventions", () => {
    assert.strictEqual(
      validateKeyValueKey(KEY_VALUE_KEY_KINDS.ENV, "1BAD", ["1BAD"])[0]
        .severity,
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
    );
    assert.strictEqual(
      validateKeyValueKey(KEY_VALUE_KEY_KINDS.ENV, "lowercase", [
        "lowercase",
      ])[0].severity,
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
    );
    assert.strictEqual(
      validateKeyValueKey(KEY_VALUE_KEY_KINDS.ENV, "CTRLYOKE_VAR_FOO", [
        "CTRLYOKE_VAR_FOO",
      ])[0].severity,
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
    );
  });

  test("validates header tokens and case-insensitive duplicates", () => {
    const invalidHeader = validateKeyValueKey(
      KEY_VALUE_KEY_KINDS.HEADER,
      "bad header",
      ["bad header"]
    );
    assert.strictEqual(
      invalidHeader[0].severity,
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
    );

    const duplicateHeader = validateKeyValueKey(
      KEY_VALUE_KEY_KINDS.HEADER,
      "Accept",
      ["Accept", "accept"]
    );
    assert.strictEqual(duplicateHeader.length, 1);
    assert.strictEqual(
      duplicateHeader[0].severity,
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
    );
  });

  test("reports exact duplicates for every key kind", () => {
    for (const kind of Object.values(KEY_VALUE_KEY_KINDS)) {
      const diagnostics = validateKeyValueKey(kind, "DUPLICATE", [
        "DUPLICATE",
        "DUPLICATE",
      ]);
      assert.ok(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR &&
            diagnostic.message.includes("duplicated exactly")
        ),
        `expected exact duplicate diagnostic for ${kind}`
      );
    }
  });

  test("warns when a non-empty value has an empty key", () => {
    const diagnostics = validateKeyValueKey(
      KEY_VALUE_KEY_KINDS.ENV,
      "",
      [""],
      "value"
    );

    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING &&
          diagnostic.message.includes("will not be saved")
      )
    );
  });

  test("stays silent for a freshly added row with no key and no value", () => {
    for (const kind of Object.values(KEY_VALUE_KEY_KINDS)) {
      assert.deepStrictEqual(
        validateKeyValueKey(kind, "", [""], ""),
        [],
        `expected no diagnostics for an untouched ${kind} row`
      );
    }
  });

  test("does not report name-pattern or duplicate errors for empty keys", () => {
    for (const kind of Object.values(KEY_VALUE_KEY_KINDS)) {
      const diagnostics = validateKeyValueKey(kind, "", ["", ""], "value");

      assert.deepStrictEqual(
        diagnostics.filter(
          (diagnostic) =>
            diagnostic.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
        ),
        [],
        `expected no error diagnostics for two blank ${kind} rows`
      );
    }
  });
});
