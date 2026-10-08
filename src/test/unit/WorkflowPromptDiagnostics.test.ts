import * as assert from "assert";
import { suite, test } from "mocha";
import { getWorkflowPromptDiagnostics } from "../../completions/WorkflowPromptDiagnostics";
import {
  CTRLYOKE_FILE_KINDS,
  PROMPT_DIAGNOSTIC_CODES,
} from "../../types/DashboardConstants";
import type { ContextReferenceResolver } from "../../utils/PromptDiagnosticRules";

/** Resolves every reference except those whose path contains "missing". */
const resolver: ContextReferenceResolver = async (references) =>
  references.map((reference) => ({
    id: reference.id,
    exists: !reference.path?.includes("missing"),
    message: "file not found",
  }));

async function diagnose(
  text: string,
  kind: (typeof CTRLYOKE_FILE_KINDS)[keyof typeof CTRLYOKE_FILE_KINDS]
) {
  const diagnostics = await getWorkflowPromptDiagnostics(text, kind, resolver);
  return diagnostics.map((d) => ({
    code: d.code,
    text: text.slice(d.from, d.to),
  }));
}

suite("getWorkflowPromptDiagnostics", () => {
  test("flags a missing file and a missing step in a .prompt.md body", async () => {
    const text = "---\nname: x\n---\nRead @missing.ts and $step:2\n";
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_STEP_MISSING,
          text: "$step:2",
        },
        {
          code: PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE,
          text: "@missing.ts",
        },
      ]
    );
  });

  test("maps ranges back through a YAML block scalar", async () => {
    const text = [
      "steps:",
      "  - prompt: |",
      "      first line",
      "      see @missing.ts here",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.WORKFLOW_YAML),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE,
          text: "@missing.ts",
        },
      ]
    );
  });

  test("maps ranges back through a JSON string with escapes", async () => {
    const text = JSON.stringify({
      steps: [{ prompt: 'say "hi"\nthen @missing.ts' }],
    });
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.WORKFLOW_JSON),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE,
          text: "@missing.ts",
        },
      ]
    );
  });

  test("counts steps before the prompt, including parallel group members", async () => {
    const text = [
      "steps:",
      "  - prompt: one",
      "  - parallel:",
      "      - prompt: two",
      "      - prompt: three",
      "  - prompt: uses $step:3 and $step:4",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.WORKFLOW_YAML),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_STEP_MISSING,
          text: "$step:4",
        },
      ]
    );
  });

  test("only flags $finalStep when the workflow has no finalStep", async () => {
    const without = "steps:\n  - prompt: a\n  - prompt: use $finalStep\n";
    const withFinal = `${without}finalStep:\n  prompt: done\n`;
    assert.deepStrictEqual(
      await diagnose(without, CTRLYOKE_FILE_KINDS.WORKFLOW_YAML),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_NO_FINAL_STEP,
          text: "$finalStep",
        },
      ]
    );
    assert.deepStrictEqual(
      await diagnose(withFinal, CTRLYOKE_FILE_KINDS.WORKFLOW_YAML),
      []
    );
  });

  test("the final step sees every step", async () => {
    const text =
      "steps:\n  - prompt: a\n  - prompt: b\nfinalStep:\n  prompt: $step:2 $step:3\n";
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.WORKFLOW_YAML),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_STEP_MISSING,
          text: "$step:3",
        },
      ]
    );
  });

  test("allows $endCondition: in retryPrompt and passRetryPrompt but not prompt", async () => {
    const text = [
      "steps:",
      "  - prompt: bad $endCondition:stdout",
      "    endCondition:",
      "      script: ./check.sh",
      "      retryPrompt: ok $endCondition:stdout",
      "      passRetryPrompt: ok $endCondition:stdout",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.WORKFLOW_YAML),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.CONDITION_END_CONDITION_OUTSIDE_RETRY,
          text: "$endCondition:stdout",
        },
      ]
    );
  });

  test("does not guess about $preCondition: since pre-conditions can be inherited", async () => {
    const text = "steps:\n  - prompt: out $preCondition:stdout\n";
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.WORKFLOW_YAML),
      []
    );
  });

  test("returns nothing for an unparseable document", async () => {
    assert.deepStrictEqual(
      await diagnose("steps: [", CTRLYOKE_FILE_KINDS.WORKFLOW_YAML),
      []
    );
  });
});
