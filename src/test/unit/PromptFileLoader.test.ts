import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { PromptFileParser } from "../../core/PromptFileParser";
import { PromptFileLoader } from "../../core/orchestration/PromptFileLoader";
import { PromptQueue } from "../../core/PromptQueue";
import { PERMISSION_MODES } from "../../types/DashboardConstants";
import { WorkflowStep, isScriptStep } from "../../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { configService } from "../../config/CtrlYokeConfigService";

suite("PromptFileLoader Tests", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    configService.setCliOverlay({});
    for (const tempDir of tempDirs.splice(0)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  suite("populateSettingsDefaults", () => {
    test("should seed executionMode from settings when not explicitly set", () => {
      const defaults = PromptFileLoader.populateSettingsDefaults({});

      assert.strictEqual(
        defaults.executionMode,
        ConfigurationUtils.getCliExecutionMode()
      );
      assert.ok(
        defaults.executionMode === "interactive" ||
          defaults.executionMode === "headless"
      );
    });

    test("should not overwrite an explicit executionMode", () => {
      const defaults = PromptFileLoader.populateSettingsDefaults({
        executionMode: "headless",
      });

      assert.strictEqual(defaults.executionMode, undefined);
    });

    test("should materialize an empty default agent as null", () => {
      configService.setCliOverlay({
        defaults: { agent: "" },
      });

      const defaults = PromptFileLoader.populateSettingsDefaults({});

      assert.strictEqual(defaults.agent, null);
    });

    test("should seed default pre- and end-conditions from settings", () => {
      const preCondition = {
        script: "node pre-check.js",
        returns: "true",
      };
      const endCondition = {
        script: "node post-check.js",
        returns: "passed",
      };
      configService.setCliOverlay({
        defaults: { preCondition, endCondition },
      });

      const defaults = PromptFileLoader.populateSettingsDefaults({});

      assert.deepStrictEqual(defaults.preCondition, preCondition);
      assert.deepStrictEqual(defaults.endCondition, endCondition);
    });

    test("should materialize disabled condition defaults as null", () => {
      configService.setCliOverlay({
        defaults: { preCondition: null, endCondition: null },
      });

      const defaults = PromptFileLoader.populateSettingsDefaults({});

      assert.strictEqual(defaults.preCondition, null);
      assert.strictEqual(defaults.endCondition, null);
    });

    test("should preserve explicit pre- and end-condition values", () => {
      configService.setCliOverlay({
        defaults: {
          preCondition: { script: "default-pre.js" },
          endCondition: {
            script: "default-end.js",
            returns: "true",
          },
        },
      });
      const explicitPreCondition = { script: "workflow-pre.js" };

      const defaults = PromptFileLoader.populateSettingsDefaults({
        preCondition: explicitPreCondition,
        endCondition: null,
      });

      assert.strictEqual(defaults.preCondition, undefined);
      assert.strictEqual(defaults.endCondition, undefined);
    });

    test("should seed toolPermissions from VS Code settings when not explicitly set", () => {
      const explicitValues: Record<string, unknown> = {
        harness: "copilot-cli",
        model: "claude-sonnet-4.5",
      };

      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);

      // toolPermissions should be seeded since it was not in explicitValues
      assert.ok(
        defaults.toolPermissions !== undefined,
        "toolPermissions should be seeded"
      );
      const tp = defaults.toolPermissions as {
        mode: string;
        allowedTools: string[];
        deniedTools: string[];
      };
      assert.ok(
        typeof tp.mode === "string",
        "toolPermissions.mode should be a string"
      );
      assert.ok(
        Array.isArray(tp.allowedTools),
        "toolPermissions.allowedTools should be an array"
      );
      assert.ok(
        Array.isArray(tp.deniedTools),
        "toolPermissions.deniedTools should be an array"
      );
    });

    test("should NOT overwrite toolPermissions when explicitly set in source", () => {
      const explicitPermissions = {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["write"],
        deniedTools: ["shell(rm:*)"],
      };
      const explicitValues: Record<string, unknown> = {
        harness: "copilot-cli",
        toolPermissions: explicitPermissions,
      };

      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);

      // toolPermissions should NOT appear in defaults since it was explicitly provided
      assert.strictEqual(
        defaults.toolPermissions,
        undefined,
        "toolPermissions should not be overwritten when explicitly set"
      );
    });

    test("should preserve toolPermissions null (explicit none)", () => {
      const explicitValues: Record<string, unknown> = {
        harness: "copilot-cli",
        toolPermissions: null,
      };

      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);

      // null is a defined value (explicit none) — should not be overwritten
      // The check is `explicitValues.toolPermissions === undefined`, and null !== undefined
      assert.strictEqual(
        defaults.toolPermissions,
        undefined,
        "toolPermissions null should be preserved (not overwritten)"
      );
    });

    test("should seed other properties alongside toolPermissions", () => {
      const explicitValues: Record<string, unknown> = {};

      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);

      // All settings-backed properties should be seeded
      assert.ok(defaults.harness !== undefined, "harness should be seeded");
      assert.ok(defaults.model !== undefined, "model should be seeded");
      assert.ok(
        defaults.resumeSession !== undefined,
        "resumeSession should be seeded"
      );
      assert.ok(
        defaults.toolPermissions !== undefined,
        "toolPermissions should be seeded"
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(defaults, "errorBehavior"),
        "errorBehavior should be seeded even when null"
      );
    });
  });

  suite("loadPromptFile property propagation", () => {
    function assertPromptStep(
      step: WorkflowStep,
      message: string
    ): asserts step is Exclude<WorkflowStep, { type: "script" }> {
      assert.ok(!isScriptStep(step), message);
    }

    test("should load all explicit properties from the manual property sync workflow into memory and the working file", async () => {
      const repoRoot = path.resolve(__dirname, "..", "..", "..");
      const manualWorkflowPath = path.join(
        repoRoot,
        "manual-test",
        "test-property-sync.ctrlyoke.yaml"
      );
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-prop-sync-")
      );
      tempDirs.push(workspaceRoot);

      const queue = new PromptQueue();
      const dashboardUpdates: any[] = [];
      const loader = new PromptFileLoader(
        new PromptFileParser(),
        queue,
        () =>
          ({
            updateFileSelected: async (
              fileName: string,
              steps: WorkflowStep[],
              workflowName: string | undefined,
              finalStep: WorkflowStep | null
            ) => {
              dashboardUpdates.push({
                fileName,
                steps,
                workflowName,
                finalStep,
              });
            },
          }) as any
      );

      const workingFilePath = await loader.loadPromptFile(
        manualWorkflowPath,
        workspaceRoot
      );

      assert.ok(workingFilePath, "working file should be created");

      const workflowFile = queue.getWorkflowFile();
      const workingFile = await queue.readWorkingFile(workingFilePath);

      for (const loaded of [workflowFile, workingFile]) {
        assert.strictEqual(loaded.harness, "copilot-cli");
        assert.strictEqual(loaded.model, "claude-sonnet-4.5");
        assert.strictEqual(loaded.agent, "test-agent");
        assert.strictEqual(loaded.resumeSession, false);
        assert.deepStrictEqual(loaded.mcpServers, ["ctrlyoke"]);
        assert.strictEqual(loaded.additionalArgs, "--max-turns 5");
        assert.deepStrictEqual(loaded.vars, {
          testEnv: "staging",
          testVersion: "1.0.0",
        });
        assert.deepStrictEqual(loaded.toolPermissions, {
          mode: "custom",
          allowedTools: ["read_file", "list_directory"],
          deniedTools: ["execute_command"],
        });
        assert.deepStrictEqual(loaded.hooks, [
          {
            event: "stop",
            command: "echo workflow-level stop hook",
            timeoutSec: 5,
          },
          {
            event: "sessionStart",
            command: "echo workflow-level sessionStart hook",
          },
          {
            event: "error",
            command: "echo workflow-level error hook",
          },
        ]);
        assert.deepStrictEqual(loaded.errorBehavior, {
          onError: "retry",
          maxRetries: 2,
          retryDelayMs: 5000,
        });
        assert.deepStrictEqual(loaded.preCondition, {
          script: "manual-test/.ctrlyoke/scripts/always_true.py",
          returns: "true",
          compareSource: "auto",
          timeout: 10000,
          onPass: "continue",
          onFail: "skipPrompt",
        });
        assert.deepStrictEqual(loaded.endCondition, {
          script: "manual-test/.ctrlyoke/scripts/always_true.py",
          returns: "true",
          compareSource: "auto",
          timeout: 30000,
          maxRetries: 2,
          resumeSessionOnRetry: true,
          onPass: "continue",
          onFail: "retry",
          retryPrompt:
            "Workflow-level retry prompt.\n" +
            "Script output: {stdout}\n" +
            "Stderr: {stderr}\n" +
            "Exit code: {exitCode}\n" +
            "Expected: {expected}\n" +
            "Actual: {actual}\n" +
            "Compare source: {compareSource}\n" +
            "Please fix and try again.\n",
        });
        assert.deepStrictEqual(loaded.finalStep, {
          type: "script",
          name: "final-cleanup-script",
          script: "manual-test/.ctrlyoke/scripts/always_true.py",
          returns: "true",
          compareSource: "auto",
          timeout: 10000,
          onPass: "continue",
          onFail: "continue",
        });
      }

      const steps = workflowFile.steps ?? [];
      assert.strictEqual(steps.length, 3);

      const stepWithAllProperties = steps[0];
      assertPromptStep(stepWithAllProperties, "step 1 should be a prompt step");
      assert.strictEqual(
        stepWithAllProperties.name,
        "test-all-step-properties"
      );
      assert.strictEqual(stepWithAllProperties.harness, "claude-cli");
      assert.strictEqual(stepWithAllProperties.model, "claude-haiku-4.5");
      assert.strictEqual(stepWithAllProperties.agent, "test-agent-alpha");
      assert.strictEqual(stepWithAllProperties.resumeSession, true);
      assert.strictEqual(stepWithAllProperties.sessionId, "my-test-session");
      assert.strictEqual(stepWithAllProperties.mcpServers, null);
      assert.deepStrictEqual(stepWithAllProperties.skills, ["commit"]);
      assert.deepStrictEqual(
        stepWithAllProperties.priorContext,
        [1, 2, 4, 5, 6]
      );
      assert.strictEqual(stepWithAllProperties.additionalArgs, "--effort low");
      assert.deepStrictEqual(stepWithAllProperties.toolPermissions, {
        mode: "dangerouslyAllowAll",
      });
      assert.deepStrictEqual(stepWithAllProperties.errorBehavior, {
        onError: "continue",
      });
      assert.deepStrictEqual(stepWithAllProperties.preCondition, {
        script: "manual-test/.ctrlyoke/scripts/always_true.py",
        returns: "true",
        compareSource: "stdout",
        timeout: 15000,
        onPass: "continue",
        onFail: "stopWorkflow",
      });
      assert.deepStrictEqual(stepWithAllProperties.endCondition, {
        script: "manual-test/.ctrlyoke/scripts/always_true.py",
        returns: "true",
        compareSource: "stdout",
        timeout: 45000,
        maxRetries: 3,
        resumeSessionOnRetry: false,
        onPass: "continue",
        onFail: "retry",
        retryPrompt:
          "Step-level retry prompt.\n" +
          "Stdout: {stdout}\n" +
          "Stderr: {stderr}\n" +
          "Exit code: {exitCode}\n" +
          "Expected: {expected}\n" +
          "Actual: {actual}\n" +
          "Compare source: {compareSource}\n" +
          "Please fix and try again.\n",
      });

      const nullOverrideStep = steps[2];
      assertPromptStep(nullOverrideStep, "step 3 should be a prompt step");
      assert.strictEqual(nullOverrideStep.agent, null);
      assert.strictEqual(nullOverrideStep.mcpServers, null);
      assert.strictEqual(nullOverrideStep.hooks, null);
      assert.strictEqual(nullOverrideStep.endCondition, null);
      assert.strictEqual(nullOverrideStep.preCondition, null);
      assert.strictEqual(nullOverrideStep.errorBehavior, null);
      assert.strictEqual(nullOverrideStep.toolPermissions, null);
      assert.strictEqual(nullOverrideStep.additionalArgs, null);

      assert.deepStrictEqual(
        workingFile.steps,
        workflowFile.steps,
        "working file should preserve the same loaded step properties as memory"
      );
      assert.strictEqual(dashboardUpdates.length, 1);
      assert.strictEqual(
        dashboardUpdates[0].fileName,
        "test-property-sync.ctrlyoke.yaml"
      );
      assert.deepStrictEqual(
        dashboardUpdates[0].steps,
        workflowFile.steps,
        "dashboard update should receive full step objects"
      );
      assert.deepStrictEqual(
        dashboardUpdates[0].finalStep,
        workflowFile.finalStep,
        "dashboard update should receive the loaded finalStep"
      );
    });
  });
});
