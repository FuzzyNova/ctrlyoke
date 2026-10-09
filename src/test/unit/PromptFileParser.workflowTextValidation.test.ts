import * as assert from "assert";
import { suite, test } from "mocha";
import { PromptFileParser } from "../../core/PromptFileParser";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CTRLYOKE_FILE_KINDS,
} from "../../types/DashboardConstants";

suite("PromptFileParser.validateWorkflowText", () => {
  const parser = new PromptFileParser();

  test("accepts a valid workflow without normalizing it", () => {
    assert.deepStrictEqual(
      parser.validateWorkflowText(
        "steps:\n  - prompt: ship it\n",
        CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
      ),
      { issues: [] }
    );
  });

  test("returns schema errors with instance paths", () => {
    const result = parser.validateWorkflowText(
      "steps:\n  - endCondition:\n      script: check.sh\n",
      CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
    );
    assert.ok(result.issues.some((issue) => issue.severity === "error"));
    assert.ok(result.issues.some((issue) => issue.instancePath === "/steps/0"));
  });

  test("keeps unknown-key closure findings as warnings", () => {
    const result = parser.validateWorkflowText(
      JSON.stringify({ steps: [{ prompt: "ship it", promtp: "typo" }] }),
      CTRLYOKE_FILE_KINDS.WORKFLOW_JSON
    );
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
      )
    );
    assert.ok(
      result.issues.some((issue) => issue.instancePath === "/steps/0/promtp")
    );
  });

  test("reports YAML syntax errors with a source position and no feedback", () => {
    const notifications: unknown[] = [];
    const feedbackParser = new PromptFileParser(undefined, {
      notify: (notification) => notifications.push(notification),
    });
    const result = feedbackParser.validateWorkflowText(
      "steps:\n  - prompt: [\n",
      CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
    );
    assert.strictEqual(result.issues[0].severity, "error");
    assert.ok(result.issues[0].position);
    assert.deepStrictEqual(notifications, []);
  });

  test("accepts prompt markdown frontmatter using the loader's metadata rules", () => {
    assert.deepStrictEqual(
      parser.validateWorkflowText(
        "---\ndescription: A prompt\n---\nBody\n",
        CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN
      ),
      { issues: [] }
    );
    const nonStringDescription = parser.validateWorkflowText(
      "---\ndescription: [bad]\n---\nBody\n",
      CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN
    );
    assert.deepStrictEqual(nonStringDescription, { issues: [] });
  });

  test("uses the same pre-normalization checks as workflow loading", async () => {
    const invalidVars = "steps:\n  - prompt: hi\nvars:\n  bad-key: value\n";
    assert.ok(
      parser
        .validateWorkflowText(invalidVars, CTRLYOKE_FILE_KINDS.WORKFLOW_YAML)
        .issues.some((issue) => issue.instancePath === "/vars")
    );
    await assert.rejects(
      parser.validateAndNormalize(
        { steps: [{ prompt: "hi" }], vars: { "bad-key": "value" } },
        "workflow.ctrlyoke.json"
      ),
      /bad-key/
    );
    const parallel = parser.validateWorkflowText(
      "steps:\n  - parallel: nope\n",
      CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
    );
    assert.ok(
      parallel.issues.some(
        (issue) =>
          issue.instancePath === "/steps/0/parallel" &&
          issue.message.includes("parallel")
      )
    );
    const newer = JSON.stringify({
      schemaVersion: 999,
      steps: [{ prompt: "hi" }],
    });
    assert.ok(
      parser
        .validateWorkflowText(newer, CTRLYOKE_FILE_KINDS.WORKFLOW_JSON)
        .issues.some((issue) => issue.message.toLowerCase().includes("newer"))
    );
    await assert.rejects(
      parser.validateAndNormalize(
        { schemaVersion: 999, steps: [{ prompt: "hi" }] },
        "workflow.ctrlyoke.json"
      ),
      /newer/i
    );
  });

  test("accepts non-string prompt markdown descriptions like the loader", () => {
    assert.deepStrictEqual(
      parser.validateWorkflowText(
        "---\ndescription: [metadata]\n---\nBody\n",
        CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN
      ),
      { issues: [] }
    );
  });

  test("deduplicates identical schema issues and names unknown properties", () => {
    const result = parser.validateWorkflowText(
      "steps:\n  - prompt: hi\n    promtp: typo\n",
      CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
    );
    const duplicates = result.issues.filter((issue) =>
      issue.message.includes("promtp")
    );
    assert.strictEqual(duplicates.length, 1);
    assert.ok(duplicates[0].message.includes("promtp"));
    assert.strictEqual(duplicates[0].severity, "warning");
  });
});
