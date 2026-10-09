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

  test("accepts prompt markdown frontmatter and validates its description", () => {
    assert.deepStrictEqual(
      parser.validateWorkflowText(
        "---\ndescription: A prompt\n---\nBody\n",
        CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN
      ),
      { issues: [] }
    );
    const invalid = parser.validateWorkflowText(
      "---\ndescription: [bad]\n---\nBody\n",
      CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN
    );
    assert.strictEqual(invalid.issues[0].instancePath, "/description");
  });
});
