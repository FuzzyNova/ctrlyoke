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
  test("flags a missing file in a .prompt.md body", async () => {
    const text = "---\nname: x\n---\nRead @missing.ts and @present.ts\n";
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE,
          text: "@missing.ts",
        },
      ]
    );
  });

  test("does not guess a .prompt.md body's position, since a step can load it", async () => {
    // A step's prompt, finalStep or retryPrompt can name the file, and the
    // body is expanded in that position at runtime; only the workflow knows it.
    const text = [
      "Use $previous, $previous:3, $all, $step:2, $finalStep",
      "and $endCondition:stdout.",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN),
      []
    );
  });

  test("still flags position-independent mistakes in a .prompt.md body", async () => {
    const text = "Fix $endCondition:stdot\n";
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.CONDITION_FIELD_UNKNOWN,
          text: "$endCondition:stdot",
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

  test("flags $preCondition: when the step, workflow, and settings have none", async () => {
    const text = "steps:\n  - prompt: out $preCondition:stdout\n";
    assert.deepStrictEqual(
      await diagnose(text, CTRLYOKE_FILE_KINDS.WORKFLOW_YAML),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.CONDITION_NO_PRE_CONDITION,
          text: "$preCondition:stdout",
        },
      ]
    );
  });

  test("honors the runtime pre-condition inheritance order", async () => {
    const prompt = (prefix: string) =>
      `steps:\n  - ${prefix}prompt: out $preCondition:stdout\n`;
    assert.deepStrictEqual(
      await getWorkflowPromptDiagnostics(
        prompt("preCondition:\n      script: check.sh\n    "),
        CTRLYOKE_FILE_KINDS.WORKFLOW_YAML,
        resolver
      ),
      []
    );
    assert.deepStrictEqual(
      await diagnose(
        "preCondition:\n  script: check.sh\nsteps:\n  - prompt: out $preCondition:stdout\n",
        CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
      ),
      []
    );
    assert.deepStrictEqual(
      await getWorkflowPromptDiagnostics(
        prompt(""),
        CTRLYOKE_FILE_KINDS.WORKFLOW_YAML,
        resolver,
        { script: "settings-check.sh" }
      ),
      []
    );
    assert.deepStrictEqual(
      await diagnose(
        "preCondition:\n  script: check.sh\nsteps:\n  - preCondition: null\n    prompt: out $preCondition:stdout\n",
        CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
      ).then((items) => items.map((item) => item.code)),
      [PROMPT_DIAGNOSTIC_CODES.CONDITION_NO_PRE_CONDITION]
    );
  });

  test("honors a settings default pre-condition in hosted prompt lint", async () => {
    const text = "steps:\n  - prompt: out $preCondition:stdout\n";
    assert.deepStrictEqual(
      await getWorkflowPromptDiagnostics(
        text,
        CTRLYOKE_FILE_KINDS.WORKFLOW_YAML,
        resolver,
        { script: "settings-check.sh" }
      ),
      []
    );
  });

  test("judges a workflow-level retryPrompt from the final step's view", async () => {
    const text = [
      "endCondition:",
      "  script: t.sh",
      "  retryPrompt: see $previous and $step:2, not $step:3",
      "steps:",
      "  - prompt: a",
      "  - prompt: b",
      "",
    ].join("\n");
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

  test("still counts earlier steps when a later line is half-typed", async () => {
    const text = [
      "steps:",
      "  - prompt: first",
      "  - prompt: use $step:1 output",
      "  - prompt: [unclosed",
      "",
    ].join("\n");
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
