import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { PromptFileParser } from "../../core/PromptFileParser";
import { PromptFileLoader } from "../../core/orchestration/PromptFileLoader";
import { PromptQueue } from "../../core/PromptQueue";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  PERMISSION_MODES,
  EXECUTION_STATES,
  PROMPT_FILE_RELOAD_MODES,
} from "../../types/DashboardConstants";
import type { UserFeedback } from "../../core/UserFeedbackSink";
import {
  PromptFile,
  WorkflowStep,
  isScriptStep,
} from "../../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { configService } from "../../config/CtrlYokeConfigService";
import { analyzeWorkflowBundle } from "../../utils/WorkflowBundleAnalyzer";
import { writeWorkflowBundle } from "../../utils/WorkflowBundleWriter";
import { parseAllFileReferences } from "../../utils/FileReferenceParser";
import { resolveReferencePath } from "../../platform/WorkspaceRootResolver";
import { StatusMessageReporter } from "../../core/orchestration/StatusMessageReporter";

function createNoopStatusReporter(): StatusMessageReporter {
  return new StatusMessageReporter(
    () => undefined,
    () => undefined
  );
}

suite("PromptFileLoader Tests", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    configService.setCliOverlay({});
    for (const tempDir of tempDirs.splice(0)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  suite("operational feedback", () => {
    test("reports parse failures through the feedback sink", async () => {
      const feedback: UserFeedback[] = [];
      const parser = {
        parsePromptFile: async () => undefined,
      } as unknown as PromptFileParser;
      const loader = new PromptFileLoader(
        parser,
        new PromptQueue(),
        undefined,
        undefined,
        undefined,
        { notify: (message) => feedback.push(message) },
        createNoopStatusReporter()
      );

      const result = await loader.loadPromptFile("missing-workflow.yaml");

      assert.strictEqual(result, undefined);
      assert.deepStrictEqual(feedback, [
        {
          severity: "error",
          message: "ctrlyoke: Failed to parse prompt file",
        },
      ]);
    });
  });

  suite("working file merge", () => {
    test("omits the definition revision from a session-replace SESSION_RESTORED", async () => {
      const dashboardCalls: unknown[][] = [];
      let restored = false;
      const dashboard = {
        updateSessionRestored: (...args: unknown[]) =>
          dashboardCalls.push(args),
      } as any;
      const queue = {
        readWorkingFile: async () => ({
          steps: [{ prompt: "restored" }],
          workflowName: "workflow",
          startedAt: 0,
          definitionRevision: 9,
          originalFile: "workflow.yaml",
        }),
        getState: () =>
          restored
            ? {
                status: EXECUTION_STATES.PAUSED,
                steps: [{ prompt: "restored" }],
                results: [],
                currentIndex: 1,
                workflowName: "workflow",
                definitionRevision: 9,
              }
            : { status: EXECUTION_STATES.IDLE, steps: [] },
        restoreFromWorkingFile: async () => {
          restored = true;
        },
        getFinalStepRuntime: () => undefined,
      } as any;
      const parser = {
        validateWorkflowSteps: () => ({ valid: true, errors: [] }),
      } as any;
      const loader = new PromptFileLoader(parser, queue, () => dashboard);

      await loader.reloadFromWorkingFile(
        "working-file.json",
        PROMPT_FILE_RELOAD_MODES.REPLACE
      );

      assert.strictEqual(dashboardCalls.length, 1);
      // The REPLACE branch loads a *different* session, so its SESSION_RESTORED
      // must not be classified as a replay of the workflow being navigated away
      // from. The webview keys that off the presence of definitionRevision on an
      // untagged message: sending it here would preserve the outgoing
      // workflow's view address and compare two unrelated workflows' revisions,
      // silently dropping a lower-revision workflow. Keep this slot undefined.
      assert.strictEqual(dashboardCalls[0][12], undefined);
    });

    test("forwards merged parallelGroups in the STEPS_EXTENDED push", async () => {
      const parallelGroups = [
        { id: "group-1", startIndex: 0, endIndex: 1, failFast: true },
      ];
      const steps: WorkflowStep[] = [
        { prompt: "existing" },
        { prompt: "appended" },
      ];
      const dashboardCalls: unknown[][] = [];
      const dashboard = {
        updateStepsExtended: (...args: unknown[]) => dashboardCalls.push(args),
      } as any;
      const queue = {
        readWorkingFile: async () => ({
          steps,
          parallelGroups,
          workflowName: "workflow",
          startedAt: 0,
          definitionRevision: 7,
        }),
        getState: () => ({
          status: EXECUTION_STATES.RUNNING,
          steps,
          parallelGroups,
          definitionRevision: 7,
        }),
        mergeStepsFromDisk: async () => 1,
        getWorkflowFile: () => ({ steps, parallelGroups }),
      } as any;
      const parser = {
        validateWorkflowSteps: () => ({ valid: true, errors: [] }),
      } as any;
      const loader = new PromptFileLoader(parser, queue, () => dashboard);

      await loader.reloadFromWorkingFile(
        "working-file.json",
        PROMPT_FILE_RELOAD_MODES.MERGE
      );

      assert.strictEqual(dashboardCalls.length, 1);
      assert.strictEqual(dashboardCalls[0][4], undefined);
      assert.deepStrictEqual(dashboardCalls[0][5], parallelGroups);
    });
  });

  suite("workflow worktree property propagation", () => {
    test("preserves each supported form in the working file", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-worktree-loader-")
      );
      tempDirs.push(workspaceRoot);

      const forms: Array<{ authored: PromptFile; expected: unknown }> = [
        {
          authored: { steps: [{ prompt: "prompt" }], worktree: false },
          expected: false,
        },
        {
          authored: { steps: [{ prompt: "prompt" }], worktree: true },
          expected: true,
        },
        {
          authored: {
            steps: [{ prompt: "prompt" }],
            worktree: "feature/short",
          },
          expected: "feature/short",
        },
        {
          authored: {
            steps: [{ type: "script", script: "npm test" }],
            worktree: {
              mode: "named",
              branch: "feature/object",
              base: "HEAD",
              setup: "npm ci",
            },
          },
          expected: {
            mode: "named",
            branch: "feature/object",
            base: "HEAD",
            setup: "npm ci",
          },
        },
      ];

      for (const [index, form] of forms.entries()) {
        const queue = new PromptQueue();
        const loader = new PromptFileLoader(new PromptFileParser(), queue);
        const workingFilePath = await loader.loadFromMemory(
          form.authored,
          `worktree-${index}`,
          workspaceRoot
        );

        if (!workingFilePath) {
          throw new Error("working file should be created");
        }
        const workingFile = await queue.readWorkingFile(workingFilePath);
        assert.deepStrictEqual(workingFile.worktree, form.expected);
      }
    });
  });

  suite("populateSettingsDefaults", () => {
    test("should seed executionMode from settings when not explicitly set", () => {
      const defaults = PromptFileLoader.populateSettingsDefaults({});

      assert.strictEqual(
        defaults.executionMode,
        ConfigurationUtils.getCliExecutionMode()
      );
      assert.ok(
        defaults.executionMode === EXECUTION_MODES.INTERACTIVE ||
          defaults.executionMode === EXECUTION_MODES.HEADLESS
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

    test("should materialize every settings-backed execution property", () => {
      const preCondition = { script: "settings-pre.js" };
      const endCondition = { script: "settings-end.js", returns: "true" };
      const hooks = [{ event: "stop" as const, command: "echo settings" }];
      const errorBehavior = { onError: "retry" as const, maxRetries: 2 };
      const toolPermissions = {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["read"],
        deniedTools: ["write"],
      };
      configService.setCliOverlay({
        defaults: {
          harness: HARNESS_IDS.CODEX_CLI,
          models: { [HARNESS_IDS.CODEX_CLI]: "settings-model" },
          additionalArgs: {
            [HARNESS_IDS.CODEX_CLI]: "--settings-args",
          },
          agent: "settings-agent",
          skills: ["settings-skill"],
          executionMode: EXECUTION_MODES.HEADLESS,
          resumeSession: true,
          priorContext: "all",
          mcpServers: ["settings-mcp"],
          hooks,
          errorBehavior,
          toolPermissions,
          preCondition,
          endCondition,
        },
      });

      const defaults = PromptFileLoader.populateSettingsDefaults({});

      assert.deepStrictEqual(defaults, {
        harness: HARNESS_IDS.CODEX_CLI,
        model: "settings-model",
        executionMode: EXECUTION_MODES.HEADLESS,
        agent: "settings-agent",
        skills: ["settings-skill"],
        resumeSession: true,
        mcpServers: ["settings-mcp"],
        hooks,
        endCondition,
        preCondition,
        priorContext: "all",
        errorBehavior,
        additionalArgs: "--settings-args",
        toolPermissions,
      });
    });

    test("should never seed over explicit workflow execution properties", () => {
      const explicitValues: Record<string, unknown> = {
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "workflow-model",
        executionMode: EXECUTION_MODES.INTERACTIVE,
        agent: null,
        skills: null,
        resumeSession: false,
        mcpServers: null,
        hooks: null,
        endCondition: null,
        preCondition: null,
        priorContext: "none",
        errorBehavior: null,
        additionalArgs: null,
        toolPermissions: null,
      };

      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);

      assert.deepStrictEqual(defaults, {});
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
          }) as any,
        undefined,
        undefined,
        undefined,
        createNoopStatusReporter()
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
            "Script output: $endCondition:stdout\n" +
            "Stderr: $endCondition:stderr\n" +
            "Exit code: $endCondition:exitCode\n" +
            "Expected: $endCondition:expected\n" +
            "Actual: $endCondition:actual\n" +
            "Compare source: $endCondition:compareSource\n" +
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
          "Stdout: $endCondition:stdout\n" +
          "Stderr: $endCondition:stderr\n" +
          "Exit code: $endCondition:exitCode\n" +
          "Expected: $endCondition:expected\n" +
          "Actual: $endCondition:actual\n" +
          "Compare source: $endCondition:compareSource\n" +
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

  suite("missing exported assets", () => {
    test("reports one workflow warning for multiple missing asset tokens", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-assets-warning-")
      );
      tempDirs.push(workspaceRoot);
      const workflowPath = path.join(workspaceRoot, "portable.ctrlyoke.yaml");
      await fs.writeFile(
        workflowPath,
        [
          "steps:",
          "  - prompt: |",
          "      Review @portable.assets/shot.png and #selection:portable.assets/code.ts:1-2.",
          "      Also inspect #sym.class:portable.assets/code.ts:Thing:1-2.",
        ].join("\n"),
        "utf8"
      );

      const statusMessages: Array<{
        stepIndex: number;
        message: string;
        severity: string;
      }> = [];
      const dashboard = () =>
        ({
          updateFileSelected: async () => {},
          updateStatusMessage: (
            stepIndex: number,
            message: string,
            severity: string
          ) => statusMessages.push({ stepIndex, message, severity }),
        }) as any;
      const loader = new PromptFileLoader(
        new PromptFileParser(),
        new PromptQueue(),
        dashboard,
        undefined,
        undefined,
        undefined,
        new StatusMessageReporter(dashboard, () => undefined)
      );

      await loader.loadPromptFile(workflowPath, workspaceRoot);

      assert.strictEqual(statusMessages.length, 1);
      assert.deepStrictEqual(statusMessages[0], {
        stepIndex: 0,
        message:
          "Workflow references missing exported assets: portable.assets. Restore the sibling *.assets/ directory or use Save As to create a portable copy.",
        severity: "warning",
      });
    });

    test("reports missing assets referenced by the top-level prompt", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-top-level-assets-warning-")
      );
      tempDirs.push(workspaceRoot);

      const statusMessages: Array<{
        stepIndex: number;
        message: string;
        severity: string;
      }> = [];
      const dashboard = () =>
        ({
          updateFileSelected: async () => {},
          updateStatusMessage: (
            stepIndex: number,
            message: string,
            severity: string
          ) => statusMessages.push({ stepIndex, message, severity }),
        }) as any;
      const loader = new PromptFileLoader(
        new PromptFileParser(),
        new PromptQueue(),
        dashboard,
        undefined,
        undefined,
        undefined,
        new StatusMessageReporter(dashboard, () => undefined)
      );

      await loader.loadFromMemory(
        {
          prompt: "Review @single-workflow.assets/missing.prompt.md",
          steps: [],
          finalStep: { type: "script", script: "echo final" },
        },
        "single-workflow.ctrlyoke.yaml",
        workspaceRoot
      );

      assert.deepStrictEqual(statusMessages, [
        {
          stepIndex: 0,
          message:
            "Workflow references missing exported assets: single-workflow.assets. Restore the sibling *.assets/ directory or use Save As to create a portable copy.",
          severity: "warning",
        },
      ]);
    });

    test("does not warn for assets beside a relocated workflow", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-relocated-assets-")
      );
      tempDirs.push(workspaceRoot);
      const workflowPath = path.join(
        workspaceRoot,
        "bundles",
        "relocated.ctrlyoke.yaml"
      );
      const assetPath = path.join(
        workspaceRoot,
        "bundles",
        "relocated.assets",
        "shot.png"
      );
      await fs.mkdir(path.dirname(assetPath), { recursive: true });
      await fs.writeFile(assetPath, "asset", "utf8");
      await fs.writeFile(
        workflowPath,
        ["steps:", "  - prompt: Use @./relocated.assets/shot.png"].join("\n"),
        "utf8"
      );

      const statusMessages: Array<{
        stepIndex: number;
        message: string;
        severity: string;
      }> = [];
      const dashboard = () =>
        ({
          updateFileSelected: async () => {},
          updateStatusMessage: (
            stepIndex: number,
            message: string,
            severity: string
          ) => statusMessages.push({ stepIndex, message, severity }),
        }) as any;
      const loader = new PromptFileLoader(
        new PromptFileParser(),
        new PromptQueue(),
        dashboard,
        undefined,
        undefined,
        undefined,
        new StatusMessageReporter(dashboard, () => undefined)
      );

      await loader.loadPromptFile(workflowPath, workspaceRoot);

      assert.deepStrictEqual(statusMessages, []);
    });

    test("round trips a bundled image after relocation within and across workspaces", async () => {
      const firstWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-relocation-round-trip-one-")
      );
      const secondWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-relocation-round-trip-two-")
      );
      tempDirs.push(firstWorkspace, secondWorkspace);

      const sourcePath = path.join(
        firstWorkspace,
        ".ctrlyoke",
        "attachments",
        "pasted image.png"
      );
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, "pasted image bytes", "utf8");

      const initialWorkflowPath = path.join(
        firstWorkspace,
        "exports",
        "pasted-workflow.ctrlyoke.json"
      );
      const sourcePrompt =
        'Review @".ctrlyoke/attachments/pasted image.png" #selection:".ctrlyoke/attachments/pasted image.png":1-2 #sym.class:".ctrlyoke/attachments/pasted image.png":Image:1-2';
      const analysis = await analyzeWorkflowBundle(
        { steps: [{ prompt: sourcePrompt }] },
        {
          workspaceRoot: firstWorkspace,
          destinationPath: initialWorkflowPath,
          sourceDefinitionPath: path.join(
            firstWorkspace,
            "authored",
            "source.yaml"
          ),
        }
      );
      await writeWorkflowBundle({
        workflowPath: initialWorkflowPath,
        serializedWorkflow: JSON.stringify(analysis.workflow, null, 2),
        plan: analysis.plan,
      });

      const relocatedWorkflowPath = path.join(
        firstWorkspace,
        "relocated",
        "pasted-workflow.ctrlyoke.json"
      );
      await fs.mkdir(path.dirname(relocatedWorkflowPath), { recursive: true });
      await fs.rename(initialWorkflowPath, relocatedWorkflowPath);
      await fs.rename(
        path.join(firstWorkspace, "exports", "pasted-workflow.assets"),
        path.join(firstWorkspace, "relocated", "pasted-workflow.assets")
      );

      const loadAndAssertRelocated = async (
        workflowPath: string,
        workspaceRoot: string
      ): Promise<void> => {
        const statusMessages: string[] = [];
        const dashboard = () =>
          ({
            updateFileSelected: async () => {},
            updateStatusMessage: (_stepIndex: number, message: string) =>
              statusMessages.push(message),
          }) as any;
        const loader = new PromptFileLoader(
          new PromptFileParser(),
          new PromptQueue(),
          dashboard,
          undefined,
          undefined,
          undefined,
          new StatusMessageReporter(dashboard, () => undefined)
        );

        await loader.loadPromptFile(workflowPath, workspaceRoot);
        assert.deepStrictEqual(statusMessages, []);

        const workflow = JSON.parse(
          await fs.readFile(workflowPath, "utf8")
        ) as {
          steps: Array<{ prompt: string }>;
        };
        for (const reference of parseAllFileReferences(
          workflow.steps[0].prompt
        )) {
          const resolved = resolveReferencePath(reference.path, {
            primaryRoot: workspaceRoot,
            namedRoots: [],
            sourceDefinitionDir: path.dirname(workflowPath),
          });
          await fs.access(resolved.absolutePath);
        }
      };

      await loadAndAssertRelocated(relocatedWorkflowPath, firstWorkspace);

      const secondWorkflowPath = path.join(
        secondWorkspace,
        "imported",
        "pasted-workflow.ctrlyoke.json"
      );
      await fs.mkdir(path.dirname(secondWorkflowPath), { recursive: true });
      await fs.copyFile(relocatedWorkflowPath, secondWorkflowPath);
      await fs.cp(
        path.join(firstWorkspace, "relocated", "pasted-workflow.assets"),
        path.join(secondWorkspace, "imported", "pasted-workflow.assets"),
        { recursive: true }
      );

      await loadAndAssertRelocated(secondWorkflowPath, secondWorkspace);
    });
  });
});
