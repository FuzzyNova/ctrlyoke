import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import Ajv from "ajv";
import * as yaml from "js-yaml";

suite("Workflow template schema", () => {
  const schemaPath = path.resolve(
    __dirname,
    "../../../schemas/workflow-schema.json"
  );
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(
    schema
  );

  test("accepts the bundled Template Starter", () => {
    const templatePath = path.resolve(
      __dirname,
      "../../../src/templates/workflows/template-starter.ctrlyoke.yaml"
    );
    const template = yaml.load(fs.readFileSync(templatePath, "utf-8"));

    assert.strictEqual(
      validate(template),
      true,
      JSON.stringify(validate.errors)
    );
  });

  test("accepts a harness placeholder in a declared template", () => {
    const valid = validate({
      _templateMeta: {
        name: "Harness template",
        variables: {
          selectedHarness: {
            type: "harness",
            default: "claude-cli",
          },
        },
      },
      steps: [
        {
          prompt: "Implement the change",
          harness: "{selectedHarness}",
        },
      ],
    });

    assert.strictEqual(valid, true, JSON.stringify(validate.errors));
  });

  test("keeps ordinary workflows restricted to real harness IDs", () => {
    const invalidWorkflows = [
      {
        harness: "{selectedHarness}",
        steps: [{ prompt: "Implement the change" }],
      },
      {
        steps: [
          {
            prompt: "Implement the change",
            harness: "{selectedHarness}",
          },
        ],
      },
      {
        steps: [],
        finalStep: {
          prompt: "Review the change",
          harness: "{selectedHarness}",
        },
      },
    ];

    for (const workflow of invalidWorkflows) {
      assert.strictEqual(validate(workflow), false);
    }
  });

  test("rejects malformed template placeholders", () => {
    const valid = validate({
      _templateMeta: {
        variables: {
          selectedHarness: { type: "harness" },
        },
      },
      steps: [
        {
          prompt: "Implement the change",
          harness: "{Selected-Harness}",
        },
      ],
    });

    assert.strictEqual(valid, false);
  });

  test("validates template variable metadata", () => {
    const valid = validate({
      _templateMeta: {
        variables: {
          selectedHarness: {
            type: "unknown-control",
          },
        },
      },
      steps: [{ prompt: "Implement the change" }],
    });

    assert.strictEqual(valid, false);
  });

  test("accepts all persisted workflow timing metadata", () => {
    const valid = validate({
      steps: [{ prompt: "Implement the change" }],
      _runtime: {
        currentIndex: 1,
        executionState: "completed",
        startTime: 100,
        pausedTime: 200,
        totalPausedDuration: 50,
        executionEndTime: 300,
      },
    });

    assert.strictEqual(valid, true, JSON.stringify(validate.errors));
  });

  test("accepts managed shorthand and object forms at both workflow roots", () => {
    const validWorkflows = [
      { prompt: "Implement the change", worktree: true },
      {
        steps: [{ prompt: "Implement the change" }],
        worktree: {
          mode: "managed",
          merge: true,
          keep: true,
          base: "main",
          setup: "npm ci",
        },
      },
      { type: "script", script: "npm test", worktree: { mode: "managed" } },
    ];

    for (const workflow of validWorkflows) {
      assert.strictEqual(
        validate(workflow),
        true,
        JSON.stringify(validate.errors)
      );
    }
  });

  test("accepts managed merge and rejects named and nested worktree locations", () => {
    const invalidWorkflows = [
      {
        prompt: "Implement the change",
        worktree: { mode: "managed", branch: "feature" },
      },
      {
        prompt: "Implement the change",
        worktree: { mode: "named", branch: "feature", merge: true },
      },
      {
        steps: [
          {
            prompt: "Implement the change",
            worktree: { mode: "managed", merge: true },
          },
        ],
      },
      {
        steps: [{ prompt: "Implement the change" }],
        finalStep: { prompt: "Review", worktree: true },
      },
      {
        steps: [{ prompt: "Implement the change" }],
        finalStep: {
          type: "script",
          script: "npm test",
          worktree: { mode: "managed", merge: true },
        },
      },
      {
        prompt: "Implement the change",
        _runtime: { worktree: { mode: "managed", merge: true } },
      },
    ];

    for (const workflow of invalidWorkflows) {
      assert.strictEqual(
        validate(workflow),
        false,
        JSON.stringify(validate.errors)
      );
    }
  });
});
