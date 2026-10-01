import * as assert from "assert";
import { suite, test } from "mocha";
import {
  substituteConditionOutputRefs,
  type ConditionOutputContext,
} from "../../core/ConditionOutputRefs";
import {
  fenceLiteral,
  LITERAL_FENCE_INFO,
  parseAtReferences,
  parseAllFileReferences,
  parseInlinePriorContextRefs,
} from "../../utils/FileReferenceParser";
import { parseSecretReferences } from "../../utils/SecretReferenceParser";
import type { ConditionEvaluationSummary } from "../../types/CtrlYokeTypes";
import {
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
} from "../../types/DashboardConstants";

const preCondition: ConditionEvaluationSummary = {
  passed: false,
  script: "pre.js",
  expected: "0",
  compareSource: "stdout",
  actual: " actual pre ",
  stdout: " pre stdout ",
  stderr: " pre stderr ",
  exitCode: 2,
  durationMs: 10,
};

const endCondition: ConditionEvaluationSummary = {
  passed: true,
  script: "end.js",
  expected: "true",
  compareSource: "stderr",
  actual: " actual end ",
  stdout: " end stdout ",
  stderr: " end stderr ",
  exitCode: 0,
  durationMs: 12,
};

suite("Condition output references", () => {
  test("resolves every supported field for both phases", () => {
    const context: ConditionOutputContext = { preCondition, endCondition };
    const fields = [
      RETRY_PROMPT_PLACEHOLDERS.STDOUT,
      RETRY_PROMPT_PLACEHOLDERS.STDERR,
      RETRY_PROMPT_PLACEHOLDERS.EXPECTED_VALUE,
      RETRY_PROMPT_PLACEHOLDERS.ACTUAL_VALUE,
      RETRY_PROMPT_PLACEHOLDERS.EXIT_CODE,
      RETRY_PROMPT_PLACEHOLDERS.COMPARE_SOURCE,
    ];
    const text = [
      ...fields.map(
        (field) => `$${SCRIPT_OUTPUT_SOURCES.PRE_CONDITION}:${field}`
      ),
      ...fields.map(
        (field) => `$${SCRIPT_OUTPUT_SOURCES.END_CONDITION}:${field}`
      ),
    ].join("|");

    const result = substituteConditionOutputRefs(text, context);

    assert.strictEqual(
      result.text,
      [
        "pre stdout",
        "pre stderr",
        "0",
        "actual pre",
        "2",
        "stdout",
        "end stdout",
        "end stderr",
        "true",
        "actual end",
        "0",
        "stderr",
      ].join("|")
    );
    assert.deepStrictEqual(result.unresolved, []);
  });

  for (const { phase, summary } of [
    { phase: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION, summary: preCondition },
    { phase: SCRIPT_OUTPUT_SOURCES.END_CONDITION, summary: endCondition },
  ]) {
    for (const { field, punctuation, value } of [
      {
        field: RETRY_PROMPT_PLACEHOLDERS.EXIT_CODE,
        punctuation: ",",
        value: String(summary.exitCode),
      },
      {
        field: RETRY_PROMPT_PLACEHOLDERS.STDERR,
        punctuation: "-",
        value: summary.stderr.trim(),
      },
      {
        field: RETRY_PROMPT_PLACEHOLDERS.STDOUT,
        punctuation: ".",
        value: summary.stdout.trim(),
      },
    ]) {
      test(`substitutes $${phase}:${field} before ${punctuation}`, () => {
        const result = substituteConditionOutputRefs(
          `$${phase}:${field}${punctuation} continue`,
          { [phase]: summary }
        );

        assert.strictEqual(result.text, `${value}${punctuation} continue`);
        assert.deepStrictEqual(result.unresolved, []);
      });
    }
  }

  test("leaves references unresolved when a phase summary is missing", () => {
    const token = "$endCondition:stdout";
    const result = substituteConditionOutputRefs(token, { preCondition });

    assert.strictEqual(result.text, token);
    assert.deepStrictEqual(result.unresolved, [
      {
        phase: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
        field: RETRY_PROMPT_PLACEHOLDERS.STDOUT,
        token,
      },
    ]);
  });

  test("leaves unknown fields untouched without reporting them", () => {
    const token = "$preCondition:unknownField";
    const result = substituteConditionOutputRefs(token, { preCondition });

    assert.strictEqual(result.text, token);
    assert.deepStrictEqual(result.unresolved, []);
  });

  for (const token of [
    "$preCondition:stdout2",
    "$preCondition:stdout_x",
    "$preCondition2:stdout",
  ]) {
    test(`leaves ${token} whole instead of expanding a known prefix`, () => {
      const result = substituteConditionOutputRefs(`${token} next`, {
        preCondition,
      });

      assert.strictEqual(result.text, `${token} next`);
      assert.deepStrictEqual(result.unresolved, []);
    });
  }

  test("uses empty expected and the exitCode compare-source default", () => {
    const summary: ConditionEvaluationSummary = {
      ...preCondition,
      expected: undefined,
      compareSource: undefined,
    };
    const result = substituteConditionOutputRefs(
      "$preCondition:expected|$preCondition:compareSource",
      { preCondition: summary }
    );

    assert.strictEqual(result.text, "|exitCode");
    assert.deepStrictEqual(result.unresolved, []);
  });

  test("does not resolve references inside fenced code blocks", () => {
    const token = "$preCondition:stdout";
    const result = substituteConditionOutputRefs(
      `\`\`\`\n${token}\n\`\`\`\n${token}`,
      { preCondition }
    );

    assert.strictEqual(result.text, `\`\`\`\n${token}\n\`\`\`\npre stdout`);
    assert.deepStrictEqual(result.unresolved, []);
  });

  test("does not expand a reference embedded in a filename-like word", () => {
    const token = "$preCondition:stdout";
    const result = substituteConditionOutputRefs(`price${token}`, {
      preCondition,
    });

    assert.strictEqual(result.text, `price${token}`);
    assert.deepStrictEqual(result.unresolved, []);
  });

  test("keeps condition output inert after an unpaired backtick run in prose", () => {
    const authoredPrompt =
      "Wrap code in ``` fences. Output: $endCondition:stdout done";
    const result = substituteConditionOutputRefs(
      authoredPrompt,
      {
        endCondition: {
          ...endCondition,
          stdout: "see !CI_TOKEN and @src/a.ts",
        },
      },
      (value, source) =>
        `\n${fenceLiteral(value, LITERAL_FENCE_INFO, source)}\n`
    );

    assert.ok(result.text.includes("\n```` text\n"));
    assert.deepStrictEqual(parseSecretReferences(result.text), []);
    assert.deepStrictEqual(parseAtReferences(result.text), []);
    assert.deepStrictEqual(parseAllFileReferences(result.text), []);
  });

  test("keeps condition output inert when it contains a fence after an authored stray fence", () => {
    const authoredPrompt =
      "Wrap code in ``` fences. Output: $endCondition:stdout done";
    const result = substituteConditionOutputRefs(
      authoredPrompt,
      {
        endCondition: {
          ...endCondition,
          stdout: "a\n```\nsee !CI_TOKEN and @src/a.ts $previous",
        },
      },
      (value, source) =>
        `\n${fenceLiteral(value, LITERAL_FENCE_INFO, source)}\n`
    );

    assert.deepStrictEqual(parseSecretReferences(result.text), []);
    assert.deepStrictEqual(parseAtReferences(result.text), []);
    assert.deepStrictEqual(parseInlinePriorContextRefs(result.text), []);
  });
});
