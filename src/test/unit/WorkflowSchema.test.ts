import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import Ajv from "ajv";
import * as yaml from "js-yaml";
import { PromptFileParser } from "../../core/PromptFileParser";
import { formatRunRef } from "../../utils/WorkflowPaths";
import { PERMISSION_MODES } from "../../types/DashboardConstants";

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

  test("accepts toolPermissions mode none and rejects passthrough", () => {
    const workflow = (mode: string) => ({
      toolPermissions: { mode },
      steps: [{ prompt: "hi" }],
    });
    assert.strictEqual(
      validate(workflow(PERMISSION_MODES.NONE)),
      true,
      JSON.stringify(validate.errors)
    );
    assert.strictEqual(validate(workflow("passthrough")), false);
  });

  test("closes conditions while accepting every script property", () => {
    const scriptProperties = {
      script: "echo ready",
      env: { CHECK_MODE: "strict" },
      shell: "pwsh",
    };
    assert.strictEqual(
      validate({
        endCondition: { ...scriptProperties, onPass: "continue" },
        preCondition: { ...scriptProperties, onFail: "skipPrompt" },
        steps: [{ prompt: "hi" }],
      }),
      true,
      JSON.stringify(validate.errors)
    );

    assert.strictEqual(
      validate({
        endCondition: { ...scriptProperties, unknown: true },
        steps: [{ prompt: "hi" }],
      }),
      false
    );
    assert.strictEqual(
      validate({
        preCondition: { ...scriptProperties, unknown: true },
        steps: [{ prompt: "hi" }],
      }),
      false
    );
  });

  test("parses and validates every bundled workflow template", async () => {
    const workflowsDirectory = path.resolve(
      __dirname,
      "../../../src/templates/workflows"
    );
    const templateFiles = fs
      .readdirSync(workflowsDirectory)
      .filter(
        (fileName) =>
          fileName.endsWith(".ctrlyoke.yaml") ||
          fileName.endsWith(".ctrlyoke.yml") ||
          fileName.endsWith(".ctrlyoke.json")
      )
      .sort();
    const parser = new PromptFileParser();

    for (const fileName of templateFiles) {
      const filePath = path.join(workflowsDirectory, fileName);
      const parsed = await parser.parsePromptFile(filePath);
      assert.ok(parsed, `${fileName} should parse`);
      const validation = parser.validateWorkflowSteps(parsed.steps ?? [], {
        finalStep: parsed.finalStep,
        parallelGroups: parsed.parallelGroups,
        workflowProperties: parsed,
      });
      // Bundled templates are the examples users copy, so they must be free of
      // warnings as well as errors — a shipped template that quietly falls back
      // to "exits 0" teaches the wrong thing.
      assert.deepStrictEqual(
        validation,
        { valid: true, errors: [], warnings: [] },
        `${fileName}: ${[
          ...validation.errors,
          ...validation.warnings.map((warning) => warning.message),
        ].join("; ")}`
      );
    }
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

  test("accepts a harness placeholder inside a declared template group", () => {
    const valid = validate({
      _templateMeta: {
        name: "Parallel harness template",
        variables: {
          selectedHarness: { type: "harness" },
        },
      },
      steps: [
        {
          parallel: [
            { prompt: "Research one", harness: "{selectedHarness}" },
            { prompt: "Research two", harness: "{selectedHarness}" },
          ],
        },
      ],
    });
    assert.strictEqual(valid, true, JSON.stringify(validate.errors));
  });

  test("accepts flat parallel members and rejects unsupported parallel shapes", () => {
    const valid = validate({
      steps: [
        { prompt: "before" },
        {
          parallel: [{ prompt: "one" }, { type: "script", script: "npm test" }],
          failFast: false,
        },
        { prompt: "after" },
      ],
    });
    assert.strictEqual(valid, true, JSON.stringify(validate.errors));

    const invalidWorkflows = [
      {
        steps: [
          {
            parallel: [{ prompt: "one" }, { parallel: [{ prompt: "nested" }] }],
          },
        ],
      },
      {
        steps: [{ parallel: [{ prompt: "only member" }] }],
      },
      {
        steps: [{ prompt: "queue step" }],
        finalStep: { parallel: [{ prompt: "one" }, { prompt: "two" }] },
      },
      {
        steps: [
          {
            parallel: [
              { prompt: "one", harness: "{selectedHarness}" },
              { prompt: "two" },
            ],
          },
        ],
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

  test("accepts valid secret grants on prompt and script steps", () => {
    const valid = validate({
      secrets: ["SUPABASE_PAT", "API_2"],
      steps: [
        { prompt: "Use !SUPABASE_PAT", secrets: ["PROMPT_SECRET"] },
        { type: "script", script: "npm test", secrets: ["SCRIPT_SECRET"] },
      ],
    });

    assert.strictEqual(valid, true, JSON.stringify(validate.errors));
  });

  test("accepts notification hooks and rejects unknown hook events", () => {
    const valid = validate({
      steps: [
        {
          prompt: "Wait for input",
          hooks: [{ event: "notification", command: "node notify.js" }],
        },
      ],
    });
    assert.strictEqual(valid, true, JSON.stringify(validate.errors));

    const invalid = validate({
      steps: [
        {
          prompt: "Wait for input",
          hooks: [{ event: "notARealHook", command: "node notify.js" }],
        },
      ],
    });
    assert.strictEqual(invalid, false);
  });

  test("rejects secret grants with invalid names", () => {
    for (const name of ["lowercase", "1START", "HAS-DASH", ""]) {
      const valid = validate({
        steps: [{ prompt: "prompt", secrets: [name] }],
      });
      assert.strictEqual(valid, false, name);
    }
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

  test("accepts the runtime metadata ctrlyoke writes to run files", () => {
    const worktree = {
      schemaVersion: 1,
      mode: "managed",
      origin: "created",
      branchName: "ctrlyoke/run-1",
      worktreePath: "/worktrees/run-1",
      executionRoot: "/worktrees/run-1",
      executionCheckoutRoot: "/worktrees/run-1",
      sourceCheckoutRoot: "/repo",
      namedWorkspaceRoots: [{ name: "repo", fsPath: "/repo" }],
      baseCommit: "abc123",
      lifecycleOwner: "ctrlyoke",
      lifecycleState: "settled",
      setupOutcome: "succeeded",
      landingOutcome: "landed",
      mergeOutcome: "fast-forward",
      directoryState: "removed",
      branchState: "present",
      conflictFiles: [],
      updatedAt: 400,
    };
    const runFile = {
      steps: [
        {
          prompt: "Implement the change",
          _runtime: {
            elapsed: 12,
            contextWindowUsed: 10,
            contextWindowSize: 20,
          },
        },
      ],
      _runtime: {
        schemaVersion: 2,
        currentIndex: 1,
        executionState: "completed",
        worktree,
        worktreeNotice: "Inherited worktree default degraded to none.",
      },
    };

    assert.strictEqual(
      validate(runFile),
      true,
      JSON.stringify(validate.errors)
    );
    assert.strictEqual(
      validate({
        ...runFile,
        _runtime: { ...runFile._runtime, worktree: { ...worktree, extra: 1 } },
      }),
      false
    );
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

  test("accepts a run address in the exact form ctrlyoke writes run refs", () => {
    const withAddress = (workflowKey: string, runRef: string) => ({
      steps: [{ prompt: "Continue", priorContext: { workflowKey, runRef } }],
    });

    assert.strictEqual(
      validate(withAddress("my-flow", formatRunRef(Date.UTC(2026, 8, 23)))),
      true,
      JSON.stringify(validate.errors)
    );

    for (const [workflowKey, runRef] of [
      ["my-flow", "run-2026-09-23"],
      ["my-flow", "run-2026-09-23T10:11:12.123Z"],
      ["nested/flow", formatRunRef(Date.UTC(2026, 8, 23))],
      ["nested\\flow", formatRunRef(Date.UTC(2026, 8, 23))],
    ]) {
      assert.strictEqual(
        validate(withAddress(workflowKey, runRef)),
        false,
        `${workflowKey} ${runRef}`
      );
    }
  });
});
