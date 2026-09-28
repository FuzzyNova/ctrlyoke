import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as jsYaml from "js-yaml";
import { suite, teardown, test } from "mocha";
import { TemplateManager } from "../../core/TemplateManager";
import { WORKFLOW_FILE_FORMATS } from "../../types/DashboardConstants";
import { EXECUTION_PROPERTY_KEYS } from "../../types/CtrlYokeTypes";
import {
  makeTempDir as createTempDir,
  removeTempDir,
} from "../helpers/tempWorkspace";

// parseTemplateMeta and mergeVariablesWithMeta are private but pure — they operate
// only on strings/objects and never touch the ExtensionContext — so we construct a
// manager with a stub context and reach the methods via `as any` to unit-test the
// variable metadata model without needing a workspace or file system.
function makeManager(): any {
  return new TemplateManager({} as never);
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = createTempDir("ctrlyoke-template-test-");
  tempDirs.push(dir);
  return dir;
}

teardown(() => {
  for (const dir of tempDirs.splice(0)) {
    removeTempDir(dir);
  }
});

suite("TemplateManager variable metadata", () => {
  suite("parseTemplateMeta", () => {
    test("parses type, fileFilter, autoFillFilename, description, default, multiline", () => {
      const tm = makeManager();
      const content = [
        "_templateMeta:",
        "  name: Demo",
        "  description: A demo",
        "  variables:",
        "    specFile:",
        "      type: file",
        "      fileFilter:",
        '        - "**/*.md"',
        "      autoFillFilename: true",
        "    testCommand:",
        "      type: text",
        "      default: npm test",
        "      description: The test command.",
        "      multiline: true",
        "steps:",
        "  - prompt: hi",
        "",
      ].join("\n");

      const meta = tm.parseTemplateMeta(content);
      assert.strictEqual(meta.name, "Demo");
      assert.strictEqual(meta.description, "A demo");
      assert.deepStrictEqual(meta.variables.specFile, {
        type: "file",
        fileFilter: ["**/*.md"],
        autoFillFilename: true,
      });
      assert.deepStrictEqual(meta.variables.testCommand, {
        type: "text",
        default: "npm test",
        description: "The test command.",
        multiline: true,
      });
    });

    test("returns empty variables when _templateMeta is absent or malformed", () => {
      const tm = makeManager();
      assert.deepStrictEqual(tm.parseTemplateMeta("steps: []").variables, {});
      assert.deepStrictEqual(
        tm.parseTemplateMeta("::: not : yaml :").variables,
        {}
      );
    });

    test("parses select (with options) and directory types", () => {
      const tm = makeManager();
      const content = [
        "_templateMeta:",
        "  variables:",
        "    logLevel:",
        "      type: select",
        "      options:",
        "        - debug",
        "        - info",
        "      default: info",
        "    outputDir:",
        "      type: directory",
        "steps: []",
      ].join("\n");
      const meta = tm.parseTemplateMeta(content);
      assert.deepStrictEqual(meta.variables.logLevel, {
        type: "select",
        options: ["debug", "info"],
        default: "info",
      });
      assert.deepStrictEqual(meta.variables.outputDir, { type: "directory" });
    });

    test("rejects an options array containing non-strings", () => {
      const tm = makeManager();
      const content = [
        "_templateMeta:",
        "  variables:",
        "    x:",
        "      type: select",
        "      options:",
        "        - ok",
        "        - 5",
        "steps: []",
      ].join("\n");
      const entry = tm.parseTemplateMeta(content).variables.x;
      assert.strictEqual(entry.type, "select");
      assert.strictEqual(entry.options, undefined);
    });

    test("ignores non-string default and non-true multiline", () => {
      const tm = makeManager();
      const content = [
        "_templateMeta:",
        "  variables:",
        "    x:",
        "      default: 123",
        "      multiline: false",
        "steps: []",
      ].join("\n");
      const entry = tm.parseTemplateMeta(content).variables.x;
      assert.strictEqual(entry.default, undefined);
      assert.strictEqual(entry.multiline, undefined);
    });
  });

  suite("mergeVariablesWithMeta", () => {
    test("enriches extracted variables by name (type, default, description, multiline)", () => {
      const tm = makeManager();
      const extracted = [
        { name: "featureDescription" },
        { name: "planDocument" },
      ];
      const meta = {
        featureDescription: {
          type: "text",
          multiline: true,
          description: "What to build",
        },
        planDocument: { type: "text", default: "docs/plan.md" },
      };
      const merged = tm.mergeVariablesWithMeta(extracted, meta, "demo");
      assert.deepStrictEqual(merged[0], {
        name: "featureDescription",
        type: "text",
        multiline: true,
        description: "What to build",
      });
      assert.deepStrictEqual(merged[1], {
        name: "planDocument",
        type: "text",
        default: "docs/plan.md",
      });
    });

    test("enriches with select options and directory type", () => {
      const tm = makeManager();
      const merged = tm.mergeVariablesWithMeta(
        [{ name: "logLevel" }, { name: "outDir" }],
        {
          logLevel: { type: "select", options: ["a", "b"], default: "a" },
          outDir: { type: "directory" },
        },
        "demo"
      );
      assert.deepStrictEqual(merged[0], {
        name: "logLevel",
        type: "select",
        options: ["a", "b"],
        default: "a",
      });
      assert.deepStrictEqual(merged[1], { name: "outDir", type: "directory" });
    });

    test("only the first autoFillFilename wins", () => {
      const tm = makeManager();
      const extracted = [{ name: "a" }, { name: "b" }];
      const meta = {
        a: { type: "file", autoFillFilename: true },
        b: { type: "file", autoFillFilename: true },
      };
      const merged = tm.mergeVariablesWithMeta(extracted, meta, "demo");
      assert.strictEqual(merged[0].autoFillFilename, true);
      assert.strictEqual(merged[1].autoFillFilename, undefined);
    });

    test("leaves variables without matching meta untouched", () => {
      const tm = makeManager();
      const extracted = [{ name: "loneVar" }];
      const merged = tm.mergeVariablesWithMeta(extracted, {}, "demo");
      assert.deepStrictEqual(merged, [{ name: "loneVar" }]);
    });
  });

  suite("extractVariables", () => {
    test("extracts template variables without treating condition refs as variables", () => {
      const tm = makeManager();
      const vars = tm.extractVariables(
        "Run {testCommand}; see @{file:specFile}; note $preCondition:stdout"
      );
      const byName = Object.fromEntries(
        vars.map((v: { name: string }) => [v.name, v])
      );
      assert.ok(byName.testCommand, "plain token extracted");
      assert.strictEqual(byName.specFile.type, "file", "typed token → file");
      assert.strictEqual(
        byName.stdout,
        undefined,
        "condition-output reference is not a template variable"
      );
    });
  });

  suite("custom template ID scope encoding", () => {
    test("buildCustomTemplateId round-trips through parseCustomTemplateId", () => {
      const tm = makeManager();
      const workspaceId = tm.buildCustomTemplateId("workspace", "my-template");
      assert.strictEqual(workspaceId, "custom:workspace:my-template");
      assert.deepStrictEqual(tm.parseCustomTemplateId(workspaceId), {
        scope: "workspace",
        name: "my-template",
      });

      const userId = tm.buildCustomTemplateId("user", "shared-template");
      assert.strictEqual(userId, "custom:user:shared-template");
      assert.deepStrictEqual(tm.parseCustomTemplateId(userId), {
        scope: "user",
        name: "shared-template",
      });
    });

    test("throws on malformed or unscoped custom template IDs", () => {
      const tm = makeManager();
      assert.throws(() => tm.parseCustomTemplateId("custom:no-scope-here"));
      assert.throws(() => tm.parseCustomTemplateId("custom:bogus-scope:name"));
    });
  });

  suite("custom template persistence", () => {
    test("clones the selected base as YAML and renames its metadata", async () => {
      const tm = makeManager();
      const templateDir = makeTempDir();
      tm.getTemplatesPathForScope = () => templateDir;
      tm.getTemplateInfo = async () => ({ id: "base" });
      tm.getTemplateContent = async () =>
        [
          "_templateMeta:",
          "  name: Base",
          "  description: Keep me",
          "  variables:",
          "    feature:",
          "      type: text",
          "steps:",
          "  - prompt: Build {feature}",
          "",
        ].join("\n");

      const createdPath = await tm.createCustomTemplate(
        "My Copy",
        "workspace",
        WORKFLOW_FILE_FORMATS.YAML,
        "base"
      );

      assert.strictEqual(
        createdPath,
        path.join(templateDir, "My Copy.ctrlyoke.yaml")
      );
      const parsed = jsYaml.load(
        await fs.promises.readFile(createdPath, "utf-8")
      ) as any;
      const source = await fs.promises.readFile(createdPath, "utf-8");
      assert.ok(!source.includes("yaml-language-server"));
      assert.strictEqual(parsed._templateMeta.name, "My Copy");
      assert.strictEqual(parsed._templateMeta.description, "Keep me");
      assert.strictEqual(parsed._templateMeta.variables.feature.type, "text");
      assert.strictEqual(parsed.steps[0].prompt, "Build {feature}");
    });

    test("saves a workflow snapshot as JSON when requested", async () => {
      const tm = makeManager();
      const templateDir = makeTempDir();
      tm.getTemplatesPathForScope = () => templateDir;

      const createdPath = await tm.saveWorkflowAsTemplate(
        "Snapshot",
        "workspace",
        { steps: [{ prompt: "Ship it" }] },
        WORKFLOW_FILE_FORMATS.JSON
      );

      assert.strictEqual(
        createdPath,
        path.join(templateDir, "Snapshot.ctrlyoke.json")
      );
      const parsed = JSON.parse(
        await fs.promises.readFile(createdPath, "utf-8")
      );
      assert.strictEqual(parsed._templateMeta.name, "Snapshot");
      assert.strictEqual(parsed.steps[0].prompt, "Ship it");
      assert.strictEqual(parsed.$schema, undefined);
    });

    test("discovers YAML, YML, and JSON templates", async () => {
      const tm = makeManager();
      const templateDir = makeTempDir();
      await Promise.all([
        fs.promises.writeFile(
          path.join(templateDir, "yaml-template.ctrlyoke.yaml"),
          "steps:\n  - prompt: yaml\n",
          "utf-8"
        ),
        fs.promises.writeFile(
          path.join(templateDir, "yml-template.ctrlyoke.yml"),
          "steps:\n  - prompt: yml\n",
          "utf-8"
        ),
        fs.promises.writeFile(
          path.join(templateDir, "json-template.ctrlyoke.json"),
          JSON.stringify({ steps: [{ prompt: "json" }] }),
          "utf-8"
        ),
      ]);

      const templates = await tm.discoverTemplatesInDir(
        templateDir,
        "workspace"
      );

      assert.deepStrictEqual(
        templates.map((template: { id: string }) => template.id).sort(),
        [
          "custom:workspace:json-template",
          "custom:workspace:yaml-template",
          "custom:workspace:yml-template",
        ]
      );
    });

    test("rejects a duplicate basename even when the formats differ", async () => {
      const tm = makeManager();
      const templateDir = makeTempDir();
      tm.getTemplatesPathForScope = () => templateDir;
      await fs.promises.writeFile(
        path.join(templateDir, "taken.ctrlyoke.json"),
        "{}",
        "utf-8"
      );

      await assert.rejects(
        tm.saveWorkflowAsTemplate(
          "taken",
          "workspace",
          { steps: [] },
          WORKFLOW_FILE_FORMATS.YAML
        ),
        /Template already exists/
      );
    });
  });

  suite("workflow instantiation", () => {
    test("preserves multiline feature descriptions in simple-feature prompts", async () => {
      const tm = makeManager();
      const workspaceDir = makeTempDir();
      const featureDescription =
        "Add login page.\nIt should support OAuth.";
      tm.getWorkspaceFolder = () => ({ uri: { fsPath: workspaceDir } });
      tm.getTemplateContent = async (templateId: string) =>
        fs.promises.readFile(
          path.resolve(
            __dirname,
            "../../templates/workflows",
            `${templateId}.ctrlyoke.yaml`
          ),
          "utf-8"
        );

      const workflow = await tm.createWorkflow("simple-feature", {
        featureDescription,
      });

      assert.strictEqual(
        workflow.steps![0].prompt,
        `${featureDescription}\n\nCreate an implementation plan for this feature. Identify all files that need changes and outline the approach.\n`
      );
    });

    test("preserves Windows paths and quotes in fix-tests commands", async () => {
      const tm = makeManager();
      const workspaceDir = makeTempDir();
      tm.getWorkspaceFolder = () => ({ uri: { fsPath: workspaceDir } });
      tm.getTemplateContent = async (templateId: string) =>
        fs.promises.readFile(
          path.resolve(
            __dirname,
            "../../templates/workflows",
            `${templateId}.ctrlyoke.yaml`
          ),
          "utf-8"
        );

      for (const testCommand of [
        ".\\tools\\run.cmd",
        ".\\scripts\\test.ps1",
        'npm test -- --grep "auth"',
      ]) {
        const workflow = await tm.createWorkflow("fix-tests", {
          testCommand,
        });
        const step = workflow.steps![0];

        assert.strictEqual(step.endCondition?.script, testCommand);
        assert.ok(step.prompt.includes(testCommand));
      }
    });

    test("keeps dollar replacement tokens literal in prompt and script values", async () => {
      const tm = makeManager();
      const workspaceDir = makeTempDir();
      const input = "echo $& and $$5";
      tm.getWorkspaceFolder = () => ({ uri: { fsPath: workspaceDir } });
      tm.getTemplateContent = async () =>
        [
          "_templateMeta:",
          "  variables:",
          "    testCommand:",
          "      type: text",
          "steps:",
          '  - prompt: "{testCommand}"',
          "    endCondition:",
          '      script: "{testCommand}"',
          "      expected: pass",
        ].join("\n");

      const workflow = await tm.createWorkflow("dollar-values", {
        testCommand: input,
      });

      assert.strictEqual(workflow.steps![0].prompt, input);
      assert.strictEqual(workflow.steps![0].endCondition?.script, input);
    });

    test("keeps the shared execution-property list aligned with the schema", () => {
      const schema = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "..", "..", "schemas", "workflow-schema.json"),
          "utf-8"
        )
      );
      const schemaKeys = Object.keys(
        schema.$defs.executionProperties.properties
      ).sort();

      assert.deepStrictEqual(schemaKeys, [...EXECUTION_PROPERTY_KEYS].sort());
    });

    test("propagates every authoring property defined by the workflow schema", async () => {
      const tm = makeManager();
      const workspaceDir = makeTempDir();
      const executionProperties = {
        harness: "codex-cli",
        model: "gpt-test",
        executionMode: "headless",
        agent: "reviewer",
        skills: ["schema-audit"],
        resumeSession: true,
        mcpServers: [
          {
            id: "stdio-server",
            command: "node",
            args: ["server.js"],
            env: { MODE: "test" },
            autoApprove: ["read"],
          },
          {
            id: "remote-server",
            url: "https://example.test/mcp",
            transport: "sse",
            headers: { Authorization: "Bearer test" },
            autoApprove: true,
          },
        ],
        hooks: [{ event: "stop", command: "echo stop", timeoutSec: 5 }],
        sessionId: "schema-session",
        endCondition: {
          script: "npm test",
          expected: "ok",
          compareSource: "stdout",
          timeoutSec: 1,
          maxRetries: 2,
          retryPrompt: "retry $endCondition:stdout",
          passRetryPrompt: "pass $endCondition:stdout",
          resumeSessionOnRetry: false,
          onPass: "retry",
          onFail: "continue",
        },
        preCondition: {
          script: "npm run precheck",
          compareSource: "exitCode",
          expected: "0",
          timeoutSec: 0.5,
          onPass: "continue",
          onFail: "skipPrompt",
        },
        priorContext: [1],
        additionalArgs: "--effort high",
        toolPermissions: {
          mode: "custom",
          allowedTools: ["read"],
          deniedTools: ["write"],
        },
        errorBehavior: {
          onError: "retry",
          maxRetries: 3,
          retryDelaySec: 0.025,
        },
      };
      const runtime = {
        startedAt: 1,
        completedAt: 2,
        terminalStatus: "completed",
        retryCount: 1,
        failureKind: "unknown",
        failureMessage: "old run",
      };
      const promptStep = {
        type: "prompt",
        name: "Prompt step",
        enabled: false,
        color: "#A1b2C3",
        prompt: "Build {feature}",
        ...executionProperties,
        _runtime: runtime,
      };
      const scriptStep = {
        type: "script",
        name: "Script step",
        enabled: false,
        color: "#123456",
        executionMode: "interactive",
        script: "npm run verify",
        compareSource: "stderr",
        expected: "warning",
        timeoutSec: 2,
        errorBehavior: executionProperties.errorBehavior,
        onPass: "stopWorkflow",
        onFail: "continue",
        _runtime: runtime,
      };
      const finalStep = {
        ...promptStep,
        name: "Final prompt",
        enabled: true,
        prompt: "Finish {feature}",
      };
      const template = {
        _templateMeta: {
          name: "Schema audit",
          description: "Exercises every template metadata property",
          variables: {
            feature: {
              type: "select",
              fileFilter: ["**/*.md"],
              options: ["audit", "verify"],
              autoFillFilename: true,
              description: "Feature name",
              default: "audit",
              multiline: true,
            },
          },
        },
        ...executionProperties,
        vars: { branch: "main" },
        steps: [promptStep, scriptStep],
        finalStep,
        originalFile: "old.ctrlyoke.yaml",
        workflowName: "Old workflow",
        startedAt: 1,
        _runtime: { currentIndex: 1, executionState: "completed" },
      };

      tm.getWorkspaceFolder = () => ({ uri: { fsPath: workspaceDir } });
      tm.getTemplateContent = async () => jsYaml.dump(template);

      const workflow = await tm.createWorkflow("schema-audit", {
        feature: "verify",
      });

      const expectedPrompt = {
        type: "prompt",
        name: "Prompt step",
        enabled: false,
        color: "#A1b2C3",
        prompt: "Build verify",
        ...executionProperties,
      };
      const expectedScript = {
        type: "script",
        name: "Script step",
        enabled: false,
        color: "#123456",
        executionMode: "interactive",
        script: "npm run verify",
        compareSource: "stderr",
        expected: "warning",
        timeoutSec: 2,
        errorBehavior: executionProperties.errorBehavior,
        onPass: "stopWorkflow",
        onFail: "continue",
      };
      assert.deepStrictEqual(workflow, {
        schemaVersion: 1,
        ...executionProperties,
        vars: { branch: "main" },
        steps: [expectedPrompt, expectedScript],
        finalStep: {
          ...expectedPrompt,
          name: "Final prompt",
          enabled: true,
          prompt: "Finish verify",
        },
      });
      assert.ok(!("_templateMeta" in workflow));
      assert.ok(!("_runtime" in workflow));
      assert.ok(!("originalFile" in workflow));
      assert.ok(!("workflowName" in workflow));
      assert.ok(!("startedAt" in workflow));
      assert.ok(!("_runtime" in workflow.steps![0]));
      assert.ok(!("_runtime" in workflow.steps![1]));
      assert.ok(!("_runtime" in workflow.finalStep!));
    });
  });
});
