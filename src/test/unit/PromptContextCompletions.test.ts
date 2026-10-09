import * as assert from "assert";
import {
  getContextualPriorCompletions,
  getWorkflowVariableCompletions,
} from "../../completions/PromptContextCompletions";
import { getWorkflowPromptCompletionContext } from "../../completions/WorkflowPromptDiagnostics";
import { CTRLYOKE_FILE_KINDS } from "../../types/DashboardConstants";
import { PROMPT_DIAGNOSTIC_FIELDS } from "../../types/DashboardConstants";

suite("PromptContextCompletions", () => {
  test("names only the prior steps in step completions", () => {
    const items = getContextualPriorCompletions("step:", {
      stepNames: ["Setup", "Build"],
      vars: {},
      field: PROMPT_DIAGNOSTIC_FIELDS.PROMPT,
      hasPreCondition: false,
      stepCount: 2,
      hasFinalStep: false,
    });
    assert.deepStrictEqual(
      items.map(({ label, detail }) => [label, detail]),
      [
        ["step:1", "Step 1: Setup"],
        ["step:2", "Step 2: Build"],
      ]
    );
  });

  test("scopes condition outputs to the field and effective pre-condition", () => {
    const prompt = getContextualPriorCompletions("", {
      stepNames: [],
      vars: {},
      field: PROMPT_DIAGNOSTIC_FIELDS.PROMPT,
      hasPreCondition: false,
      stepCount: 0,
      hasFinalStep: false,
    });
    assert.ok(!prompt.some((item) => item.label.startsWith("endCondition:")));
    assert.ok(!prompt.some((item) => item.label.startsWith("preCondition:")));

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

  test("hides context completions that are invalid at the current position", () => {
    const firstStep = getContextualPriorCompletions("", {
      stepNames: [],
      vars: {},
      field: PROMPT_DIAGNOSTIC_FIELDS.PROMPT,
      hasPreCondition: false,
      stepCount: 0,
      hasFinalStep: false,
    });
    assert.ok(
      !firstStep.some((item) =>
        /^(previous|all|step:|previous:)$/.test(item.label)
      )
    );
    assert.ok(
      !firstStep.some((item) => /^(finalStep|allFinalStep)$/.test(item.label))
    );

    const laterStep = getContextualPriorCompletions("", {
      stepNames: ["First"],
      vars: {},
      field: PROMPT_DIAGNOSTIC_FIELDS.PROMPT,
      hasPreCondition: false,
      stepCount: 1,
      hasFinalStep: true,
    });
    assert.ok(laterStep.some((item) => item.label === "previous"));
    assert.ok(laterStep.some((item) => item.label === "finalStep"));
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
