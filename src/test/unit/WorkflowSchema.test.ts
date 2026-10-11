import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import * as yaml from "js-yaml";
import { PromptFileParser } from "../../core/PromptFileParser";
import { formatRunRef } from "../../utils/WorkflowPaths";
import {
  EXECUTION_STATES,
  HARNESS_IDS,
  PERMISSION_MODES,
  STATUS_LINE_HARNESS_IDS,
} from "../../types/DashboardConstants";
import { VARIABLE_NAME_PATTERN_SOURCE } from "../../utils/KeyValueKeyKinds";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";

suite("Workflow template schema", () => {
  const schemaPath = path.resolve(
    __dirname,
    "../../../schemas/workflow-schema.json"
  );
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const workflowAjv = new Ajv({ allErrors: true, allowUnionTypes: true });
  addFormats(workflowAjv);
  const validate = workflowAjv.compile(schema);

  test("accepts the bundled Template Starter", () => {
    const templatePath = path.resolve(
      __dirname,
      "../../../src/templates/workflows/template-starter.ctrlyoke.yaml"
    );
    const template = yaml.load(fs.readFileSync(templatePath, "utf-8"));
    assert.strictEqual(
      (template as { schemaVersion?: number }).schemaVersion,
      1
    );

    assert.strictEqual(
      validate(template),
      true,
      JSON.stringify(validate.errors)
    );
  });

  test("stamps every bundled workflow template with schemaVersion 1", () => {
    const workflowsDirectory = path.resolve(
      __dirname,
      "../../../src/templates/workflows"
    );
    const templateFiles = fs
      .readdirSync(workflowsDirectory)
      .filter((fileName) => fileName.endsWith(".ctrlyoke.yaml"));
    assert.ok(templateFiles.length > 0);
    for (const fileName of templateFiles) {
      const template = yaml.load(
        fs.readFileSync(path.join(workflowsDirectory, fileName), "utf8")
      ) as { schemaVersion?: number };
      const source = fs.readFileSync(
        path.join(workflowsDirectory, fileName),
        "utf8"
      );
      assert.strictEqual(template.schemaVersion, 1, fileName);
      // An in-file schema link would override the extension's bundled
      // yamlValidation association and fetch the remote schema instead.
      assert.ok(
        !source.includes("yaml-language-server"),
        `${fileName} should rely on the bundled schema association`
      );
    }
  });

  test("requires the prompt field on prompt steps", () => {
    assert.strictEqual(
      validate({ steps: [{ prompt: "Test prompt" }] }),
      true,
      JSON.stringify(validate.errors)
    );
    assert.strictEqual(
      validate({ steps: [{ endCondition: { script: "test.py" } }] }),
      false
    );
  });

  test("accepts schemaVersion and $schema on every closed workflow root and settings root", () => {
    const roots = [
      {
        $schema: "https://ctrlyoke.dev/schema/v1/workflow.json",
        schemaVersion: 1,
        steps: [{ prompt: "multi-step root" }],
      },
      {
        $schema: "https://ctrlyoke.dev/schema/v1/workflow.json",
        schemaVersion: 1,
        prompt: "single prompt root",
      },
      {
        $schema: "https://ctrlyoke.dev/schema/v1/workflow.json",
        schemaVersion: 1,
        type: "script",
        script: "echo root script",
      },
    ];
    for (const root of roots) {
      assert.strictEqual(validate(root), true, JSON.stringify(validate.errors));
    }

    const settingsSchema = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../schemas/settings-schema.json"),
        "utf8"
      )
    );
    const settingsAjv = new Ajv({ allErrors: true });
    addFormats(settingsAjv);
    settingsAjv.addSchema(schema, schema.$id);
    const validateSettings = settingsAjv.compile(settingsSchema);
    assert.strictEqual(
      validateSettings({
        $schema: "https://ctrlyoke.dev/schema/v1/settings.json",
        schemaVersion: 1,
      }),
      true,
      JSON.stringify(validateSettings.errors)
    );
    assert.strictEqual(
      validateSettings({ defaults: { harness: "not-a-harness" } }),
      false,
      "the settings schema should resolve workflow.json by its $id"
    );
    assert.strictEqual(
      validate({ schemaVersion: 0, steps: [{ prompt: "x" }] }),
      false
    );
  });

  test("refuses newer workflow versions before schema validation for YAML, JSON, and Markdown", async () => {
    const tempDir = fs.mkdtempSync(path.join(__dirname, "schema-refusal-"));
    try {
      const cases = [
        [
          "deploy.ctrlyoke.yaml",
          "schemaVersion: 2\nunknownFutureField: true\n",
        ],
        [
          "deploy.ctrlyoke.json",
          JSON.stringify({ schemaVersion: 2, future: true }),
        ],
        [
          "deploy.prompt.md",
          "---\nschemaVersion: 2\nfuture: true\n---\nDo the work",
        ],
      ] as const;
      for (const [fileName, content] of cases) {
        const filePath = path.join(tempDir, fileName);
        fs.writeFileSync(filePath, content, "utf8");
        const parser = new PromptFileParser();
        assert.strictEqual(await parser.parsePromptFile(filePath), null);
        assert.match(
          parser.lastNewerSchemaError?.message ?? "",
          new RegExp(
            `${fileName.replaceAll(".", "\\.")} \\([^)]+\\) uses workflow format 2`
          )
        );
        assert.match(
          parser.lastNewerSchemaError?.message ?? "",
          /supports format 1/u
        );
        assert.match(
          parser.lastNewerSchemaError?.message ?? "",
          /this version \([^)]+\)/u
        );
        assert.match(
          parser.lastNewerSchemaError?.message ?? "",
          /Update ctrlyoke to open it\./u
        );
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("uses the shared variable-name pattern and rejects case collisions", async () => {
    assert.strictEqual(
      schema.$defs.varsConfig.propertyNames.pattern,
      `^${VARIABLE_NAME_PATTERN_SOURCE}$`
    );
    assert.strictEqual(
      validate({ vars: { valid_name2: "ok" }, steps: [{ prompt: "hi" }] }),
      true,
      JSON.stringify(validate.errors)
    );
    assert.strictEqual(
      validate({ vars: { "bad-name": "no" }, steps: [{ prompt: "hi" }] }),
      false
    );

    await assert.rejects(
      new PromptFileParser().validateAndNormalize(
        { vars: { foo: "one", FOO: "two" }, steps: [{ prompt: "hi" }] },
        process.cwd()
      ),
      /vars: Variable names must not differ only by case/
    );
  });

  test("requires exactly one MCP command or URL", () => {
    const workflow = (entry: Record<string, unknown>) => ({
      mcpServers: [{ id: "server", ...entry }],
      steps: [{ prompt: "hi" }],
    });

    assert.strictEqual(validate(workflow({ command: "node" })), true);
    assert.strictEqual(
      validate(workflow({ url: "https://example.test" })),
      true
    );
    assert.strictEqual(
      validate(workflow({ command: "node", url: "https://example.test" })),
      false
    );
    assert.strictEqual(validate(workflow({})), false);
    assert.strictEqual(
      validate({
        mcpServers: [{ id: "ctrlyoke", command: "node" }],
        steps: [{ prompt: "hi" }],
      }),
      false,
      "the built-in server entry must not also match a user-defined config"
    );
  });

  test("parses the documented built-in ctrlyoke denied-tools entry at workflow and step level", async () => {
    const deniedTools = [
      "append_step",
      "edit_step",
      "remove_step",
      "reorder_steps",
    ];
    const mcpServers = [{ id: "ctrlyoke", deniedTools }];
    const parser = new PromptFileParser();

    for (const workflow of [
      { mcpServers, steps: [{ prompt: "Read the queue." }] },
      {
        steps: [{ prompt: "Read the queue.", mcpServers }],
      },
    ]) {
      const parsed = await parser.validateAndNormalize(
        workflow,
        "workflow.ctrlyoke.yaml"
      );
      const firstStep = parsed.steps?.[0];
      const parsedServers =
        "mcpServers" in workflow
          ? parsed.mcpServers
          : firstStep && "mcpServers" in firstStep
            ? firstStep.mcpServers
            : undefined;
      assert.deepStrictEqual(parsedServers, mcpServers);
    }
  });

  test("tightens integer fields, ports, and workflow run addresses", () => {
    for (const value of [-1, 1, 30]) {
      assert.strictEqual(
        validate({ steps: [{ prompt: "hi" }], maxSteps: value }),
        true
      );
    }
    for (const value of [0, -2, null]) {
      assert.strictEqual(
        validate({ steps: [{ prompt: "hi" }], maxSteps: value }),
        false
      );
    }
    assert.strictEqual(
      validate({
        steps: [{ prompt: "hi" }],
        endCondition: { script: "true", maxRetries: 0 },
      }),
      true
    );
    assert.strictEqual(
      validate({ steps: [{ prompt: "hi", sessionId: 1 }] }),
      true
    );
    assert.strictEqual(
      validate({ steps: [{ prompt: "hi", sessionId: 1.5 }] }),
      false
    );
    assert.strictEqual(
      validate({ steps: [{ prompt: "hi", sessionId: 0 }] }),
      false
    );
    assert.strictEqual(
      validate({
        steps: [{ prompt: "hi" }],
        endCondition: { script: "true", maxRetries: 1.5 },
      }),
      false
    );
    assert.strictEqual(
      validate({
        steps: [{ prompt: "hi" }],
        hooks: [{ event: "stop", command: "x", timeoutSec: 0 }],
      }),
      false
    );

    for (const workflowKey of [".", ".."])
      assert.strictEqual(
        validate({
          steps: [
            {
              prompt: "hi",
              priorContext: {
                workflowKey,
                runRef: formatRunRef(Date.UTC(2026, 8, 23)),
              },
            },
          ],
        }),
        false,
        workflowKey
      );
  });

  test("uses positive fractional seconds for workflow script and retry timeouts", () => {
    const validWorkflow = {
      steps: [
        {
          type: "script",
          script: "true",
          timeoutSec: 0.25,
        },
        {
          prompt: "hi",
          endCondition: { script: "true", timeoutSec: 1.25 },
          preCondition: { script: "true", timeoutSec: 0.5 },
          errorBehavior: {
            onError: "retry",
            retryDelaySec: 0.75,
          },
        },
      ],
    };
    assert.strictEqual(
      validate(validWorkflow),
      true,
      JSON.stringify(validate.errors)
    );

    for (const timeoutSec of [0, -0.5]) {
      assert.strictEqual(
        validate({ steps: [{ type: "script", script: "true", timeoutSec }] }),
        false
      );
      assert.strictEqual(
        validate({
          steps: [
            { prompt: "hi", endCondition: { script: "true", timeoutSec } },
          ],
        }),
        false
      );
      assert.strictEqual(
        validate({
          steps: [
            {
              prompt: "hi",
              errorBehavior: { onError: "retry", retryDelaySec: timeoutSec },
            },
          ],
        }),
        false
      );
    }

    assert.strictEqual(
      validate({
        hooks: [{ event: "stop", command: "true", timeoutSec: 1.5 }],
        steps: [{ prompt: "hi" }],
      }),
      false
    );
    assert.strictEqual(
      validate({
        hooks: [{ event: "stop", command: "true", timeoutSec: 1 }],
        steps: [{ prompt: "hi" }],
      }),
      true
    );
  });

  test("tightens settings numbers without invalidating defaults", () => {
    const settingsSchema = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../schemas/settings-schema.json"),
        "utf-8"
      )
    );
    const settingsAjv = new Ajv({ allErrors: true });
    addFormats(settingsAjv);
    settingsAjv.addSchema(schema, schema.$id);
    const validateSettings = settingsAjv.compile(settingsSchema);
    const { execution, queue, runs, terminal, ui, server } =
      CTRLYOKE_SETTINGS_DEFAULTS;
    const defaults = {
      execution: {
        maxPromptTimeoutSec: execution.maxPromptTimeoutSec,
        scriptTimeoutSec: execution.scriptTimeoutSec,
      },
      queue: {
        maxSteps: queue.maxSteps,
        maxWorkflowExecutionTimeSec: queue.maxWorkflowExecutionTimeSec,
      },
      runs: { maxRuns: runs.maxRuns },
      terminal: { scrollback: terminal.scrollback },
      ui: {
        outputVirtualizationRowThreshold: ui.outputVirtualizationRowThreshold,
      },
      server: {
        port: server.port,
        fallbackPorts: server.fallbackPorts,
      },
    };
    assert.strictEqual(
      validateSettings(defaults),
      true,
      JSON.stringify(validateSettings.errors)
    );
    assert.strictEqual(validateSettings({ server: { port: 65536 } }), false);
    assert.strictEqual(validateSettings({ server: { port: 0 } }), false);
    assert.strictEqual(validateSettings({ queue: { maxSteps: 1.5 } }), false);
    assert.strictEqual(
      validateSettings({ execution: { maxPromptTimeoutSec: 1.5 } }),
      false
    );
    assert.strictEqual(
      validateSettings({ queue: { maxWorkflowExecutionTimeSec: 1.5 } }),
      false
    );
    assert.strictEqual(validateSettings({ runs: { maxRuns: -2 } }), false);
    assert.strictEqual(validateSettings({ runs: { maxRuns: 1.5 } }), false);
    for (const value of [0, -2, null]) {
      assert.strictEqual(
        validateSettings({ queue: { maxSteps: value } }),
        false
      );
    }
    for (const value of [-1, 1, 30]) {
      assert.strictEqual(
        validateSettings({ queue: { maxSteps: value } }),
        true
      );
    }
    assert.strictEqual(
      validateSettings({ execution: { maxPromptTimeoutSec: 0 } }),
      false
    );
    assert.strictEqual(
      validateSettings({ queue: { maxWorkflowExecutionTimeSec: 0 } }),
      false
    );
    assert.strictEqual(validateSettings({ runs: { maxRuns: 0 } }), false);
    assert.strictEqual(
      validateSettings({ server: { fallbackPorts: [65536] } }),
      false
    );
    assert.strictEqual(
      validateSettings({ defaults: { priorContext: "all" } }),
      true
    );
    assert.strictEqual(
      validateSettings({ defaults: { priorContext: [1, 3] } }),
      true
    );
    assert.strictEqual(
      validateSettings({
        defaults: {
          priorContext: {
            workflowKey: "example",
            runRef: formatRunRef(Date.UTC(2026, 8, 23)),
          },
        },
      }),
      false
    );
  });

  test("keeps harness-keyed schema properties aligned with supported harnesses", () => {
    const settingsSchema = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../schemas/settings-schema.json"),
        "utf-8"
      )
    );
    const expectedHarnessIds = Object.values(HARNESS_IDS);
    const sortedHarnessIds = [...expectedHarnessIds].sort();
    const harnessKeyedSchemaPaths: Array<{
      path: string[];
      expected: string[];
    }> = [
      {
        path: ["properties", "defaults", "properties", "models"],
        expected: sortedHarnessIds,
      },
      {
        path: ["properties", "defaults", "properties", "additionalArgs"],
        expected: sortedHarnessIds,
      },
      {
        path: ["properties", "statusLine", "properties", "byHarness"],
        expected: Object.values(STATUS_LINE_HARNESS_IDS).sort(),
      },
      {
        path: [
          "properties",
          "ui",
          "properties",
          "harnessColors",
          "properties",
          "byHarness",
        ],
        expected: sortedHarnessIds,
      },
    ];
    const getSchemaAtPath = (
      source: Record<string, unknown>,
      schemaPath: string[]
    ): Record<string, unknown> =>
      schemaPath.reduce<Record<string, unknown>>(
        (current, segment) => current[segment] as Record<string, unknown>,
        source
      );

    for (const { path: schemaPath, expected } of harnessKeyedSchemaPaths) {
      const keyedObject = getSchemaAtPath(settingsSchema, schemaPath);
      assert.deepStrictEqual(
        Object.keys(keyedObject.properties as Record<string, unknown>).sort(),
        expected,
        schemaPath.join(".")
      );
    }

    assert.deepStrictEqual(schema.$defs.harnessId.enum, expectedHarnessIds);
  });

  test("accepts every execution state the run file can persist", () => {
    assert.deepStrictEqual(
      schema.$defs.runtimeMetadata.properties.executionState.enum,
      Object.values(EXECUTION_STATES)
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
      startedAt: 100,
      definitionRevision: 3,
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
    assert.strictEqual(validate({ ...runFile, definitionRevision: 0 }), false);
  });

  test("accepts every workflow-only root property on a single-step script workflow", () => {
    const scriptRoot = {
      type: "script",
      script: "npm test",
      worktree: "feature/script",
      vars: { target: "ci" },
      trustedExternalRoots: ["/shared/fixtures"],
    };
    assert.strictEqual(
      validate(scriptRoot),
      true,
      JSON.stringify(validate.errors)
    );
    assert.strictEqual(
      validate({ ...scriptRoot, trustedExternalRoots: null }),
      true,
      JSON.stringify(validate.errors)
    );
    assert.strictEqual(
      validate({ ...scriptRoot, _templateMeta: { name: "Script check" } }),
      true,
      JSON.stringify(validate.errors)
    );
    assert.strictEqual(
      validate({ ...scriptRoot, trustedExternalRoots: [""] }),
      false
    );
  });

  test("accepts the schema closure probe shapes and repository workflows", async () => {
    const validProbes = [
      {
        steps: [
          {
            prompt: "Implement the change",
            preCondition: { script: "npm test" },
            endCondition: { script: "npm test", expected: 0 },
          },
          {
            parallel: [
              { prompt: "Review the implementation" },
              { type: "script", script: "npm run lint" },
            ],
            failFast: true,
          },
        ],
        finalStep: { prompt: "Summarize the result" },
      },
      {
        prompt: "Use a single-step prompt workflow",
        worktree: true,
        vars: { target: "workspace" },
        trustedExternalRoots: ["/shared/fixtures"],
      },
      {
        type: "script",
        script: "npm test",
        _templateMeta: { name: "Script check" },
      },
      {
        _templateMeta: { name: "Harness template" },
        steps: [{ prompt: "Work with {harness}", harness: "{harness}" }],
      },
      {
        steps: [
          {
            prompt: "Run file step",
            _runtime: {
              harness: "claude-cli",
              sessionId: "session",
              startedAt: 1,
              completedAt: 2,
              terminalStatus: "completed",
            },
          },
        ],
        parallelGroups: [],
        startedAt: 1,
        definitionRevision: 1,
        _runtime: {
          schemaVersion: 1,
          currentIndex: 1,
          executionState: "completed",
        },
      },
    ];

    for (const probe of validProbes) {
      assert.strictEqual(
        validate(probe),
        true,
        JSON.stringify(validate.errors)
      );
    }

    const parser = new PromptFileParser();
    const templateDirectory = path.resolve(
      __dirname,
      "../../../src/templates/workflows"
    );
    const repoWorkflowDirectory = path.resolve(
      __dirname,
      "../../../.ctrlyoke/workflows"
    );
    const templateFiles = fs
      .readdirSync(templateDirectory)
      .filter((name) => /\.ctrlyoke\.(?:ya?ml|json)$/u.test(name))
      .map((name) => path.join(templateDirectory, name));
    const repoWorkflowFiles = fs.existsSync(repoWorkflowDirectory)
      ? fs
          .readdirSync(repoWorkflowDirectory)
          .filter((name) => /\.ctrlyoke\.(?:ya?ml|json)$/u.test(name))
          .map((name) => path.join(repoWorkflowDirectory, name))
      : [];

    for (const filePath of [...templateFiles, ...repoWorkflowFiles]) {
      const parsed = await parser.parsePromptFile(filePath);
      assert.ok(parsed, `${filePath} should parse`);
      if (templateFiles.includes(filePath)) {
        assert.deepStrictEqual(
          parsed.warnings,
          [],
          `${filePath} should not have unknown-key warnings`
        );
      }
    }
  });

  test("downgrades only unknown-key closure failures and reports exact paths", async () => {
    const tempDirectory = fs.mkdtempSync(
      path.join(require("os").tmpdir(), "ctrlyoke-schema-closure-")
    );
    const parser = new PromptFileParser();
    const cases: Array<{ document: unknown; path: string }> = [
      {
        document: { steps: [{ prompt: "Do work", endConditon: {} }] },
        path: "/steps/0/endConditon",
      },
      {
        document: { steps: [{ prompt: "Do work" }], endConditon: {} },
        path: "/endConditon",
      },
      {
        document: { prompt: "Do work", endConditon: {} },
        path: "/endConditon",
      },
      {
        document: { type: "script", script: "npm test", scriptt: true },
        path: "/scriptt",
      },
      {
        document: {
          steps: [{ prompt: "Do work" }],
          finalStep: { prompt: "Finish", endConditon: {} },
        },
        path: "/finalStep/endConditon",
      },
      {
        document: {
          steps: [
            {
              parallel: [
                { prompt: "Do work", endConditon: {} },
                { prompt: "Review" },
              ],
            },
          ],
        },
        path: "/steps/0/parallel/0/endConditon",
      },
      {
        document: {
          steps: [{ prompt: "Do work", _runtime: { elasped: 1 } }],
        },
        path: "/steps/0/_runtime/elasped",
      },
      {
        document: {
          steps: [
            {
              parallel: [{ prompt: "One" }, { prompt: "Two" }],
              failfast: false,
            },
          ],
        },
        path: "/steps/0/failfast",
      },
    ];

    try {
      for (const [index, { document, path: expectedPath }] of cases.entries()) {
        assert.strictEqual(
          validate(document),
          false,
          `probe ${index} must fail strict schema validation`
        );
        const filePath = path.join(
          tempDirectory,
          `probe-${index}.ctrlyoke.json`
        );
        fs.writeFileSync(filePath, JSON.stringify(document), "utf8");
        const parsed = await parser.parsePromptFile(filePath);
        assert.ok(parsed, `probe ${index} should load with warnings`);
        assert.deepStrictEqual(
          parsed.warnings.map((warning) => warning.propertyPointer),
          [expectedPath],
          `probe ${index} warning path`
        );
        assert.ok(parsed.warnings[0].message.includes("newer ctrlyoke"));
      }

      for (const document of [
        { steps: [{ prompt: "Do work", script: "npm test" }] },
        { steps: [{ prompt: "Do work", worktree: true }] },
      ]) {
        assert.strictEqual(validate(document), false);
        const filePath = path.join(tempDirectory, "hard-error.ctrlyoke.json");
        fs.writeFileSync(filePath, JSON.stringify(document), "utf8");
        assert.strictEqual(await parser.parsePromptFile(filePath), null);
      }
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
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
