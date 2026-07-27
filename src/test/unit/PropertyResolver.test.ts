import * as assert from "assert";
import { teardown } from "mocha";
import { PropertyResolver } from "../../utils/PropertyResolver";
import { PromptFile, PromptStep } from "../../types/CtrlYokeTypes";
import {
  PERMISSION_MODES,
  HARNESS_IDS,
  EXECUTION_MODES,
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";

suite("PropertyResolver Tests", () => {
  teardown(() => {
    PropertyResolver.setHostCanProvidePty(true);
    configService.setCliOverlay({});
  });

  suite("execution property precedence contracts", () => {
    test("runtime-fallback properties resolve prompt, then workflow, then settings", () => {
      configService.setCliOverlay({
        defaults: {
          harness: HARNESS_IDS.COPILOT_CLI,
          models: {
            [HARNESS_IDS.COPILOT_CLI]: "settings-model",
          },
          executionMode: EXECUTION_MODES.HEADLESS,
          agent: "settings-agent",
          skills: ["settings-skill"],
          resumeSession: true,
          mcpServers: ["settings-mcp"],
          priorContext: "previous",
          additionalArgs: {
            [HARNESS_IDS.COPILOT_CLI]: "--settings",
          },
        },
      });

      const workflow: PromptFile = {
        steps: [],
        harness: HARNESS_IDS.CODEX_CLI,
        model: "workflow-model",
        executionMode: EXECUTION_MODES.HEADLESS,
        agent: "workflow-agent",
        skills: ["workflow-skill"],
        resumeSession: false,
        mcpServers: ["workflow-mcp"],
        priorContext: "all",
        additionalArgs: "--workflow",
      };
      const prompt: PromptStep = {
        prompt: "test",
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "prompt-model",
        executionMode: EXECUTION_MODES.INTERACTIVE,
        agent: "prompt-agent",
        skills: ["prompt-skill"],
        resumeSession: true,
        mcpServers: ["prompt-mcp"],
        priorContext: [1],
        additionalArgs: "--prompt",
      };

      const fromPrompt = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(fromPrompt.harness, HARNESS_IDS.CLAUDE_CLI);
      assert.strictEqual(fromPrompt.model, "prompt-model");
      assert.strictEqual(fromPrompt.executionMode, EXECUTION_MODES.INTERACTIVE);
      assert.strictEqual(fromPrompt.agent, "prompt-agent");
      assert.deepStrictEqual(fromPrompt.skills, ["prompt-skill"]);
      assert.strictEqual(fromPrompt.resumeSession, true);
      assert.deepStrictEqual(fromPrompt.mcpServers, ["prompt-mcp"]);
      assert.deepStrictEqual(fromPrompt.priorContext, [1]);
      assert.strictEqual(fromPrompt.additionalArgs, "--prompt");

      const fromWorkflow = PropertyResolver.resolve(
        {
          prompt: "test",
          harness: undefined,
          model: undefined,
          executionMode: undefined,
          agent: undefined,
          skills: undefined,
          resumeSession: undefined,
          mcpServers: undefined,
          priorContext: undefined,
          additionalArgs: undefined,
        },
        workflow
      );
      assert.strictEqual(fromWorkflow.harness, HARNESS_IDS.CODEX_CLI);
      assert.strictEqual(fromWorkflow.model, "workflow-model");
      assert.strictEqual(fromWorkflow.executionMode, EXECUTION_MODES.HEADLESS);
      assert.strictEqual(fromWorkflow.agent, "workflow-agent");
      assert.deepStrictEqual(fromWorkflow.skills, ["workflow-skill"]);
      assert.strictEqual(fromWorkflow.resumeSession, false);
      assert.deepStrictEqual(fromWorkflow.mcpServers, ["workflow-mcp"]);
      assert.strictEqual(fromWorkflow.priorContext, "all");
      assert.strictEqual(fromWorkflow.additionalArgs, "--workflow");

      const fromSettings = PropertyResolver.resolve(
        { prompt: "test" },
        { steps: [] }
      );
      assert.strictEqual(fromSettings.harness, HARNESS_IDS.COPILOT_CLI);
      assert.strictEqual(fromSettings.model, "settings-model");
      assert.strictEqual(fromSettings.executionMode, EXECUTION_MODES.HEADLESS);
      assert.strictEqual(fromSettings.agent, "settings-agent");
      assert.deepStrictEqual(fromSettings.skills, ["settings-skill"]);
      assert.strictEqual(fromSettings.resumeSession, true);
      assert.deepStrictEqual(fromSettings.mcpServers, ["settings-mcp"]);
      assert.strictEqual(fromSettings.priorContext, "previous");
      assert.strictEqual(fromSettings.additionalArgs, "--settings");
    });

    test("undefined prompt properties inherit every workflow-resolved value", () => {
      const workflow: PromptFile = {
        steps: [],
        agent: "workflow-agent",
        skills: ["workflow-skill"],
        mcpServers: ["workflow-mcp"],
        hooks: [{ event: "stop", command: "echo workflow" }],
        sessionId: "workflow-session",
        endCondition: { script: "workflow-end.js", returns: "true" },
        preCondition: { script: "workflow-pre.js" },
        additionalArgs: "--workflow",
        toolPermissions: {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["read"],
          deniedTools: ["write"],
        },
        errorBehavior: { onError: "retry", maxRetries: 2 },
      };

      const resolved = PropertyResolver.resolve(
        {
          prompt: "test",
          agent: undefined,
          skills: undefined,
          mcpServers: undefined,
          hooks: undefined,
          sessionId: undefined,
          endCondition: undefined,
          preCondition: undefined,
          additionalArgs: undefined,
          toolPermissions: undefined,
          errorBehavior: undefined,
        },
        workflow
      );

      assert.strictEqual(resolved.agent, "workflow-agent");
      assert.deepStrictEqual(resolved.skills, ["workflow-skill"]);
      assert.deepStrictEqual(resolved.mcpServers, ["workflow-mcp"]);
      assert.deepStrictEqual(resolved.hooks, [
        { event: "stop", command: "echo workflow" },
      ]);
      assert.strictEqual(resolved.sessionId, "workflow-session");
      assert.deepStrictEqual(resolved.endCondition, {
        script: "workflow-end.js",
        returns: "true",
      });
      assert.deepStrictEqual(resolved.preCondition, {
        script: "workflow-pre.js",
      });
      assert.strictEqual(resolved.additionalArgs, "--workflow");
      assert.deepStrictEqual(resolved.toolPermissions, {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["read"],
        deniedTools: ["write"],
      });
      assert.deepStrictEqual(resolved.errorBehavior, {
        onError: "retry",
        maxRetries: 2,
      });
    });

    test("prompt policies override materialized workflow policies", () => {
      const resolved = PropertyResolver.resolve(
        {
          prompt: "test",
          hooks: [{ event: "stop", command: "echo prompt" }],
          endCondition: {
            script: "prompt-end.js",
            returns: "passed",
          },
          preCondition: { script: "prompt-pre.js" },
          toolPermissions: {
            mode: PERMISSION_MODES.CUSTOM,
            allowedTools: ["prompt-read"],
            deniedTools: [],
          },
          errorBehavior: { onError: "continue" },
        },
        {
          steps: [],
          hooks: [{ event: "stop", command: "echo workflow" }],
          endCondition: {
            script: "workflow-end.js",
            returns: "passed",
          },
          preCondition: { script: "workflow-pre.js" },
          toolPermissions: {
            mode: PERMISSION_MODES.ALLOW_ALL,
          },
          errorBehavior: { onError: "retry", maxRetries: 2 },
        }
      );

      assert.deepStrictEqual(resolved.hooks, [
        { event: "stop", command: "echo prompt" },
      ]);
      assert.deepStrictEqual(resolved.endCondition, {
        script: "prompt-end.js",
        returns: "passed",
      });
      assert.deepStrictEqual(resolved.preCondition, {
        script: "prompt-pre.js",
      });
      assert.deepStrictEqual(resolved.toolPermissions, {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["prompt-read"],
        deniedTools: [],
      });
      assert.deepStrictEqual(resolved.errorBehavior, {
        onError: "continue",
      });
    });

    test("null prompt properties explicitly disable every nullable inherited value", () => {
      const workflow: PromptFile = {
        steps: [],
        agent: "workflow-agent",
        skills: ["workflow-skill"],
        mcpServers: ["workflow-mcp"],
        hooks: [{ event: "stop", command: "echo workflow" }],
        endCondition: { script: "workflow-end.js", returns: "true" },
        preCondition: { script: "workflow-pre.js" },
        additionalArgs: "--workflow",
        toolPermissions: {
          mode: PERMISSION_MODES.ALLOW_ALL,
        },
        errorBehavior: { onError: "retry", maxRetries: 2 },
      };

      const resolved = PropertyResolver.resolve(
        {
          prompt: "test",
          agent: null,
          skills: null,
          mcpServers: null,
          hooks: null,
          endCondition: null,
          preCondition: null,
          additionalArgs: null,
          toolPermissions: null,
          errorBehavior: null,
        },
        workflow
      );

      assert.strictEqual(resolved.agent, undefined);
      assert.strictEqual(resolved.skills, undefined);
      assert.strictEqual(resolved.mcpServers, null);
      assert.strictEqual(resolved.hooks, null);
      assert.strictEqual(resolved.endCondition, undefined);
      assert.strictEqual(resolved.preCondition, undefined);
      assert.strictEqual(resolved.additionalArgs, undefined);
      assert.strictEqual(resolved.toolPermissions, null);
      assert.strictEqual(resolved.errorBehavior, undefined);
    });

    test("non-nullable empty values still override inherited values", () => {
      const resolved = PropertyResolver.resolve(
        {
          prompt: "test",
          resumeSession: false,
          priorContext: "none",
        },
        {
          steps: [],
          resumeSession: true,
          priorContext: "all",
        }
      );

      assert.strictEqual(resolved.resumeSession, false);
      assert.strictEqual(resolved.priorContext, "none");
    });
  });

  suite("resolveHarness", () => {
    test("should use prompt-level harness when specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
        harness: HARNESS_IDS.CLAUDE_CLI,
      };
      const workflow: PromptFile = {
        steps: [],
        harness: HARNESS_IDS.COPILOT_CLI, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.harness, HARNESS_IDS.CLAUDE_CLI);
    });

    test("should use workflow-level harness when prompt-level not specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        harness: HARNESS_IDS.CLAUDE_CLI,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.harness, HARNESS_IDS.CLAUDE_CLI);
    });

    test("should fall back to VS Code setting when neither prompt nor workflow specify harness", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Should default to ConfigurationUtils.getIntegrationMode() result
      assert.ok(resolved.harness); // Harness should be defined
    });
  });

  suite("resolveModel", () => {
    test("should use prompt-level model when specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
        model: "gpt-5",
      };
      const workflow: PromptFile = {
        steps: [],
        model: "claude-haiku-4.5", // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.model, "gpt-5");
    });

    test("should use workflow-level model when prompt-level not specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        model: "claude-haiku-4.5",
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.model, "claude-haiku-4.5");
    });

    test("should fall back to harness-specific model when neither prompt nor workflow specify model", () => {
      const prompt: PromptStep = {
        prompt: "test",
        harness: HARNESS_IDS.COPILOT_CLI,
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Should default to ConfigurationUtils.getCliModel() for CopilotCli
      assert.ok(resolved.model); // Model should be defined
    });
  });

  suite("resolveAgent", () => {
    test("should use prompt-level agent when specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
        agent: "code-reviewer",
      };
      const workflow: PromptFile = {
        steps: [],
        agent: "bug-hunter", // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.agent, "code-reviewer");
    });

    test("should use workflow-level agent when prompt-level not specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        agent: "bug-hunter",
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.agent, "bug-hunter");
    });

    test("should return undefined when no agent specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Agent may be undefined or fall back to global setting
      // We don't assert strict undefined since it depends on VS Code settings
      assert.ok(
        resolved.agent === undefined || typeof resolved.agent === "string"
      );
    });
  });

  suite("resolveResumeSession", () => {
    test("should use prompt-level resumeSession when specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
        resumeSession: true,
      };
      const workflow: PromptFile = {
        steps: [],
        resumeSession: false, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.resumeSession, true);
    });

    test("should use workflow-level resumeSession when prompt-level not specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        resumeSession: true,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.resumeSession, true);
    });

    test("should fall back to VS Code setting when neither prompt nor workflow specify resumeSession", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Should default to ConfigurationUtils.shouldResumeExistingSession()
      assert.strictEqual(typeof resolved.resumeSession, "boolean");
    });
  });

  suite("resolveExecutionMode", () => {
    teardown(() => {
      PropertyResolver.setHostCanProvidePty(true);
      configService.setCliOverlay({});
    });

    test("uses prompt over workflow over settings", () => {
      configService.setCliOverlay({
        defaults: { executionMode: EXECUTION_MODES.HEADLESS },
      });

      const workflow: PromptFile = {
        steps: [],
        executionMode: EXECUTION_MODES.HEADLESS,
      };
      const prompt: PromptStep = {
        prompt: "test",
        executionMode: EXECUTION_MODES.INTERACTIVE,
      };

      assert.strictEqual(
        PropertyResolver.resolve(prompt, workflow).executionMode,
        EXECUTION_MODES.INTERACTIVE
      );
      assert.strictEqual(
        PropertyResolver.resolve({ prompt: "test" }, workflow).executionMode,
        EXECUTION_MODES.HEADLESS
      );
      assert.strictEqual(
        PropertyResolver.resolve({ prompt: "test" }, { steps: [] })
          .executionMode,
        EXECUTION_MODES.HEADLESS
      );
    });

    test("undefined inherits and an unavailable host clamps interactive to headless", () => {
      configService.setCliOverlay({
        defaults: { executionMode: EXECUTION_MODES.INTERACTIVE },
      });
      PropertyResolver.setHostCanProvidePty(false);

      assert.strictEqual(
        PropertyResolver.resolve(
          { prompt: "test" },
          { steps: [], executionMode: EXECUTION_MODES.INTERACTIVE }
        ).executionMode,
        EXECUTION_MODES.HEADLESS
      );
      assert.strictEqual(
        PropertyResolver.resolve(
          { prompt: "test" },
          { steps: [], executionMode: EXECUTION_MODES.HEADLESS }
        ).executionMode,
        EXECUTION_MODES.HEADLESS
      );
    });
  });

  suite("resolveMcpServers", () => {
    test("should use prompt-level mcpServers when specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
        mcpServers: ["ctrlyoke"],
      };
      const workflow: PromptFile = {
        steps: [],
        mcpServers: null, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.mcpServers, ["ctrlyoke"]);
    });

    test("should use workflow-level mcpServers when prompt-level not specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        mcpServers: ["ctrlyoke"],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.mcpServers, ["ctrlyoke"]);
    });

    test("should default to empty array when neither prompt nor workflow specify mcpServers", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.mcpServers, []);
    });

    test("should return null when prompt explicitly disables mcpServers", () => {
      const prompt: PromptStep = {
        prompt: "test",
        mcpServers: null,
      };
      const workflow: PromptFile = {
        steps: [],
        mcpServers: ["ctrlyoke"],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.mcpServers, null);
    });
  });

  suite("resolveEndCondition", () => {
    test("should use prompt-level endCondition when specified", () => {
      const promptCondition = {
        script: "prompt-test.js",
        returns: "true",
      };
      const workflowCondition = {
        script: "workflow-test.js",
        returns: "true",
      };

      const prompt: PromptStep = {
        prompt: "test",
        endCondition: promptCondition,
      };
      const workflow: PromptFile = {
        steps: [],
        endCondition: workflowCondition, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.endCondition, promptCondition);
    });

    test("should use workflow-level endCondition when prompt-level not specified", () => {
      const workflowCondition = {
        script: "workflow-test.js",
        returns: "true",
      };

      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        endCondition: workflowCondition,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.endCondition, workflowCondition);
    });

    test("should return undefined when no endCondition specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.endCondition, undefined);
    });

    test("should inherit workflow endCondition when prompt value is undefined", () => {
      const workflowCondition = {
        script: "workflow-test.js",
        returns: "true",
      };

      const prompt: PromptStep = {
        prompt: "test",
        endCondition: undefined,
      };
      const workflow: PromptFile = {
        steps: [],
        endCondition: workflowCondition,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.endCondition, workflowCondition);
    });
  });

  suite("resolveSessionId", () => {
    test("should use prompt-level sessionId when specified (string)", () => {
      const prompt: PromptStep = {
        prompt: "test",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
      };
      const workflow: PromptFile = {
        steps: [],
        sessionId: "other-session-id", // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(
        resolved.sessionId,
        "550e8400-e29b-41d4-a716-446655440000"
      );
    });

    test("should use prompt-level sessionId when specified (number)", () => {
      const prompt: PromptStep = {
        prompt: "test",
        sessionId: 1,
      };
      const workflow: PromptFile = {
        steps: [],
        sessionId: "workflow-session-id", // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, 1);
    });

    test("should use workflow-level sessionId when prompt-level not specified (string)", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        sessionId: "workflow-session-id",
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, "workflow-session-id");
    });

    test("should use workflow-level sessionId when prompt-level not specified (number)", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        sessionId: 2,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, 2);
    });

    test("should return undefined when no sessionId specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, undefined);
    });

    test("should return undefined when workflow sessionId is empty string", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        sessionId: "",
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, undefined);
    });

    test("should return undefined when prompt sessionId is empty string and prompt overrides resumeSession", () => {
      const prompt: PromptStep = {
        prompt: "test",
        sessionId: "",
        resumeSession: true, // prompt controls the resume tier, so its empty sessionId wins
      };
      const workflow: PromptFile = {
        steps: [],
        sessionId: "workflow-session-id", // should not be used when prompt owns resume tier
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, undefined);
    });

    test("should fall through to workflow sessionId when prompt sessionId is empty but resumeSession is default", () => {
      const prompt: PromptStep = {
        prompt: "test",
        sessionId: "", // user cleared the field but did not override resumeSession
      };
      const workflow: PromptFile = {
        steps: [],
        sessionId: "workflow-session-id",
        resumeSession: true,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, "workflow-session-id");
    });
  });

  suite("resolveToolPermissions", () => {
    test("should return null (none) when prompt toolPermissions is null", () => {
      const prompt: PromptStep = {
        prompt: "test",
        toolPermissions: null,
      };
      const workflow: PromptFile = {
        steps: [],
        toolPermissions: {
          mode: PERMISSION_MODES.ALLOW_ALL,
          allowedTools: [],
          deniedTools: [],
        },
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.toolPermissions, null);
    });

    test("should return null (none) when workflow toolPermissions is null and prompt is undefined", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        toolPermissions: null,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.toolPermissions, null);
    });

    test("should return null (none) when both levels are undefined", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.toolPermissions, null);
    });

    test("should return null (none) when mode is 'none'", () => {
      const prompt: PromptStep = {
        prompt: "test",
        toolPermissions: { mode: PERMISSION_MODES.NONE },
      };
      const workflow: PromptFile = {
        steps: [],
        toolPermissions: { mode: PERMISSION_MODES.ALLOW_ALL },
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.toolPermissions, null);
    });

    test("should return null (none) when workflow mode is 'none' and prompt is undefined", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        toolPermissions: { mode: PERMISSION_MODES.NONE },
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.toolPermissions, null);
    });

    test("should use prompt-level config when it overrides workflow-level", () => {
      const prompt: PromptStep = {
        prompt: "test",
        toolPermissions: {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["write"],
          deniedTools: [],
        },
      };
      const workflow: PromptFile = {
        steps: [],
        toolPermissions: { mode: PERMISSION_MODES.ALLOW_ALL },
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.toolPermissions, {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["write"],
        deniedTools: [],
      });
    });

    test("should use workflow-level config when prompt is undefined", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        steps: [],
        toolPermissions: {
          mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
          allowedTools: [],
          deniedTools: [],
        },
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.toolPermissions, {
        mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
        allowedTools: [],
        deniedTools: [],
      });
    });

    test("should default mode to 'allowAll' when mode is omitted in override object", () => {
      const prompt: PromptStep = {
        prompt: "test",
        toolPermissions: { allowedTools: ["write"] },
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.ok(resolved.toolPermissions);
      assert.strictEqual(
        resolved.toolPermissions.mode,
        PERMISSION_MODES.ALLOW_ALL
      );
      assert.deepStrictEqual(resolved.toolPermissions.allowedTools, ["write"]);
    });

    test("should default allowedTools and deniedTools to [] when omitted", () => {
      const prompt: PromptStep = {
        prompt: "test",
        toolPermissions: { mode: PERMISSION_MODES.CUSTOM },
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.ok(resolved.toolPermissions);
      assert.strictEqual(
        resolved.toolPermissions.mode,
        PERMISSION_MODES.CUSTOM
      );
      assert.deepStrictEqual(resolved.toolPermissions.allowedTools, []);
      assert.deepStrictEqual(resolved.toolPermissions.deniedTools, []);
    });

    test("should preserve full config when all fields are specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
        toolPermissions: {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["write", "shell(git:*)"],
          deniedTools: ["shell(rm:*)"],
        },
      };
      const workflow: PromptFile = {
        steps: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.toolPermissions, {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["write", "shell(git:*)"],
        deniedTools: ["shell(rm:*)"],
      });
    });
  });

  suite("resolveHooks", () => {
    test("should use prompt-level hooks when specified", () => {
      const prompt: PromptStep = {
        prompt: "test",
        hooks: [{ event: "stop", command: "npm test" }],
      };
      const workflow: PromptFile = {
        steps: [],
        hooks: [{ event: "stop", command: "echo default" }],
      };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Prompt-level stop hooks replace workflow-level stop hooks
      assert.deepStrictEqual(resolved.hooks, [
        { event: "stop", command: "npm test" },
      ]);
    });

    test("should use workflow-level hooks when prompt-level not specified", () => {
      const prompt: PromptStep = { prompt: "test" };
      const workflow: PromptFile = {
        steps: [],
        hooks: [{ event: "stop", command: "npm test" }],
      };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.hooks, [
        { event: "stop", command: "npm test" },
      ]);
    });

    test("should default to empty array when neither prompt nor workflow specify hooks", () => {
      const prompt: PromptStep = { prompt: "test" };
      const workflow: PromptFile = { steps: [] };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.hooks, []);
    });

    test("should return null when prompt explicitly disables hooks", () => {
      const prompt: PromptStep = {
        prompt: "test",
        hooks: null,
      };
      const workflow: PromptFile = {
        steps: [],
        hooks: [{ event: "stop", command: "npm test" }],
      };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.hooks, null);
    });

    test("should return null when workflow explicitly disables hooks and prompt has no override", () => {
      const prompt: PromptStep = { prompt: "test" };
      const workflow: PromptFile = {
        steps: [],
        hooks: null,
      };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.hooks, null);
    });

    test("should perform per-event override — prompt stop replaces workflow stop but keeps workflow sessionStart", () => {
      const prompt: PromptStep = {
        prompt: "test",
        hooks: [{ event: "stop", command: "node extra-validation.js" }],
      };
      const workflow: PromptFile = {
        steps: [],
        hooks: [
          { event: "stop", command: "npm test" },
          { event: "sessionStart", command: "node notify.js" },
        ],
      };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      // stop is overridden, sessionStart is inherited
      assert.ok(Array.isArray(resolved.hooks));
      const hooks = resolved.hooks!;
      const stopHooks = hooks.filter((h) => h.event === "stop");
      const startHooks = hooks.filter((h) => h.event === "sessionStart");
      assert.strictEqual(stopHooks.length, 1);
      assert.strictEqual(stopHooks[0].command, "node extra-validation.js");
      assert.strictEqual(startHooks.length, 1);
      assert.strictEqual(startHooks[0].command, "node notify.js");
    });

    test("should support multiple hooks on the same event", () => {
      const prompt: PromptStep = {
        prompt: "test",
        hooks: [
          { event: "stop", command: "npm test" },
          { event: "stop", command: "node notify.js" },
        ],
      };
      const workflow: PromptFile = { steps: [] };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.ok(Array.isArray(resolved.hooks));
      assert.strictEqual(resolved.hooks!.length, 2);
    });
  });

  suite("full precedence chain", () => {
    test("should correctly apply three-tier precedence for all properties", () => {
      const prompt: PromptStep = {
        prompt: "test",
        harness: HARNESS_IDS.CLAUDE_CLI, // Override
        // model: not specified - should use workflow
        agent: "code-reviewer", // Override
        // resumeSession: not specified - should use workflow
        mcpServers: ["ctrlyoke"], // Override
        // endCondition: not specified - should use workflow
      };

      const workflow: PromptFile = {
        steps: [],
        // harness: not specified - prompt overrides anyway
        model: "opus", // Should be used
        // agent: not specified - prompt overrides anyway
        resumeSession: true, // Should be used
        // mcpServers: not specified - prompt overrides anyway
        endCondition: {
          script: "test.js",
          returns: "true",
        }, // Should be used
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);

      assert.strictEqual(resolved.harness, HARNESS_IDS.CLAUDE_CLI); // From prompt
      assert.strictEqual(resolved.model, "opus"); // From workflow
      assert.strictEqual(resolved.agent, "code-reviewer"); // From prompt
      assert.strictEqual(resolved.resumeSession, true); // From workflow
      assert.deepStrictEqual(resolved.mcpServers, ["ctrlyoke"]); // From prompt
      assert.deepStrictEqual(resolved.endCondition, {
        script: "test.js",
        returns: "true",
      }); // From workflow
    });
  });
});
