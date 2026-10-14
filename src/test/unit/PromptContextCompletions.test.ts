import * as assert from "assert";
import {
  getContextualPriorCompletions,
  getWorkflowVariableCompletions,
} from "../../completions/PromptContextCompletions";
import { getWorkflowPromptCompletionContext } from "../../completions/WorkflowPromptDiagnostics";
import {
  CTRLYOKE_FILE_KINDS,
  PRIOR_CONTEXT_KEYWORDS,
} from "../../types/DashboardConstants";
import { PROMPT_DIAGNOSTIC_FIELDS } from "../../types/DashboardConstants";

suite("PromptContextCompletions", () => {
  const twoSteps = {
    stepNames: ["Setup", "Build"],
    vars: {},
    field: PROMPT_DIAGNOSTIC_FIELDS.PROMPT,
    hasPreCondition: false,
    stepCount: 2,
    hasFinalStep: false,
  };

  test("names only the prior steps in step completions", () => {
    const items = getContextualPriorCompletions("step:", twoSteps);
    assert.deepStrictEqual(
      items.map(({ label, detail }) => [label, detail?.split(" — ")[0]]),
      [
        ["step:1", "Step 1: Setup"],
        ["step:2", "Step 2: Build"],
        ["step:summary:", "Summary form, e.g. $step:summary:1,3-5"],
      ]
    );
    assert.deepStrictEqual(
      getContextualPriorCompletions("step:2", twoSteps).map(
        ({ label }) => label
      ),
      ["step:2"]
    );
  });

  test("names the prior steps after step:summary:", () => {
    const items = getContextualPriorCompletions("step:summary:", twoSteps);
    assert.deepStrictEqual(
      items.map(({ label, detail }) => [label, detail]),
      [
        ["step:summary:1", "Step 1: Setup (summary)"],
        ["step:summary:2", "Step 2: Build (summary)"],
      ]
    );
  });

  test("offers pre-condition output before a pre-condition exists", () => {
    const prompt = getContextualPriorCompletions("", {
      stepNames: [],
      vars: {},
      field: PROMPT_DIAGNOSTIC_FIELDS.PROMPT,
      hasPreCondition: false,
      stepCount: 0,
      hasFinalStep: false,
    });
    assert.ok(!prompt.some((item) => item.label.startsWith("endCondition:")));
    assert.ok(prompt.some((item) => item.label.startsWith("preCondition:")));

    const retry = getContextualPriorCompletions("", {
      stepNames: [],
      vars: {},
      field: PROMPT_DIAGNOSTIC_FIELDS.RETRY_PROMPT,
      hasPreCondition: true,
      stepCount: 2,
      hasFinalStep: true,
    });
    assert.ok(retry.some((item) => item.label.startsWith("endCondition:")));
    assert.ok(retry.some((item) => item.label.startsWith("preCondition:")));
  });

  test("completes workflow vars using VarSubstitutor name syntax", () => {
    assert.deepStrictEqual(
      getWorkflowVariableCompletions(
        { project_name: "x", invalid: "x" },
        "project"
      ).map((item) => [item.label, item.insertText]),
      [["project_name", "project_name}} "]]
    );
  });

  test("offers references a later edit could make valid, full and summary alike", () => {
    const firstStep = getContextualPriorCompletions("", {
      stepNames: [],
      vars: {},
      field: PROMPT_DIAGNOSTIC_FIELDS.PROMPT,
      hasPreCondition: false,
      stepCount: 0,
      hasFinalStep: false,
    });
    const labels = new Set(firstStep.map((item) => item.label));
    for (const label of [
      PRIOR_CONTEXT_KEYWORDS.PREVIOUS,
      "previous:",
      "all",
      "step:",
      "finalStep",
      "allFinalStep",
      "previous:summary",
      "finalStep:summary",
      "step:summary:",
    ]) {
      assert.ok(labels.has(label), label);
    }
  });

  test("derives visible step names and vars from the workflow document", () => {
    const text = [
      "steps:",
      "  - name: First",
      "    prompt: one",
      "  - name: Current",
      "    prompt: '$step:'",
      "  - name: Later",
      "    prompt: three",
      "vars:",
      "  project_name: demo",
    ].join("\n");
    const offset = text.indexOf("$step:") + "$step:".length;
    const context = getWorkflowPromptCompletionContext(
      text,
      CTRLYOKE_FILE_KINDS.WORKFLOW_YAML,
      offset
    );
    assert.deepStrictEqual(context?.stepNames, ["First"]);
    assert.strictEqual(context?.vars.project_name, "demo");
    assert.strictEqual(context?.stepCount, 1);
    assert.strictEqual(context?.hasFinalStep, false);
  });

  test("uses every step for workflow-level retry prompts", () => {
    const text = [
      "steps:",
      "  - name: First",
      "    prompt: one",
      "  - name: Second",
      "    prompt: two",
      "endCondition:",
      "  retryPrompt: '$step:'",
    ].join("\n");
    const offset = text.indexOf("$step:") + "$step:".length;
    const context = getWorkflowPromptCompletionContext(
      text,
      CTRLYOKE_FILE_KINDS.WORKFLOW_YAML,
      offset
    );
    assert.deepStrictEqual(context?.stepNames, ["First", "Second"]);
  });
});
