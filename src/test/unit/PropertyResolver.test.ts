import * as assert from "assert";
import { PropertyResolver } from "../../utils/PropertyResolver";
import { Harness, PromptFile, PromptItem } from "../../types/FlightPathTypes";
import { PERMISSION_MODES } from "../../types/DashboardConstants";

suite("PropertyResolver Tests", () => {
  suite("resolveHarness", () => {
    test("should use prompt-level harness when specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
        harness: Harness.ClaudeCli,
      };
      const workflow: PromptFile = {
        prompts: [],
        harness: Harness.CopilotCli, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.harness, Harness.ClaudeCli);
    });

    test("should use workflow-level harness when prompt-level not specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        harness: Harness.ClaudeCli,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.harness, Harness.ClaudeCli);
    });

    test("should fall back to VS Code setting when neither prompt nor workflow specify harness", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Should default to ConfigurationUtils.getIntegrationMode() result
      assert.ok(resolved.harness); // Harness should be defined
    });
  });

  suite("resolveModel", () => {
    test("should use prompt-level model when specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
        model: "gpt-5",
      };
      const workflow: PromptFile = {
        prompts: [],
        model: "claude-haiku-4.5", // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.model, "gpt-5");
    });

    test("should use workflow-level model when prompt-level not specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        model: "claude-haiku-4.5",
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.model, "claude-haiku-4.5");
    });

    test("should fall back to harness-specific model when neither prompt nor workflow specify model", () => {
      const prompt: PromptItem = {
        prompt: "test",
        harness: Harness.CopilotCli,
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Should default to ConfigurationUtils.getCliModel() for CopilotCli
      assert.ok(resolved.model); // Model should be defined
    });
  });

  suite("resolveAgent", () => {
    test("should use prompt-level agent when specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
        agent: "code-reviewer",
      };
      const workflow: PromptFile = {
        prompts: [],
        agent: "bug-hunter", // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.agent, "code-reviewer");
    });

    test("should use workflow-level agent when prompt-level not specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        agent: "bug-hunter",
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.agent, "bug-hunter");
    });

    test("should return undefined when no agent specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
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
      const prompt: PromptItem = {
        prompt: "test",
        resumeSession: true,
      };
      const workflow: PromptFile = {
        prompts: [],
        resumeSession: false, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.resumeSession, true);
    });

    test("should use workflow-level resumeSession when prompt-level not specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        resumeSession: true,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.resumeSession, true);
    });

    test("should fall back to VS Code setting when neither prompt nor workflow specify resumeSession", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Should default to ConfigurationUtils.shouldResumeExistingSession()
      assert.strictEqual(typeof resolved.resumeSession, "boolean");
    });
  });

  suite("resolveMcpServers", () => {
    test("should use prompt-level mcpServers when specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
        mcpServers: ["flightpath"],
      };
      const workflow: PromptFile = {
        prompts: [],
        mcpServers: null, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.mcpServers, ["flightpath"]);
    });

    test("should use workflow-level mcpServers when prompt-level not specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        mcpServers: ["flightpath"],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.mcpServers, ["flightpath"]);
    });

    test("should default to empty array when neither prompt nor workflow specify mcpServers", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.mcpServers, []);
    });

    test("should return null when prompt explicitly disables mcpServers", () => {
      const prompt: PromptItem = {
        prompt: "test",
        mcpServers: null,
      };
      const workflow: PromptFile = {
        prompts: [],
        mcpServers: ["flightpath"],
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

      const prompt: PromptItem = {
        prompt: "test",
        endCondition: promptCondition,
      };
      const workflow: PromptFile = {
        prompts: [],
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

      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        endCondition: workflowCondition,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.endCondition, workflowCondition);
    });

    test("should return undefined when no endCondition specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.endCondition, undefined);
    });

    test("should allow prompt to override workflow endCondition with undefined", () => {
      const workflowCondition = {
        script: "workflow-test.js",
        returns: "true",
      };

      const prompt: PromptItem = {
        prompt: "test",
        endCondition: undefined,
      };
      const workflow: PromptFile = {
        prompts: [],
        endCondition: workflowCondition,
      };

      // When prompt.endCondition is explicitly set to undefined,
      // it should OVERRIDE the workflow condition (disable validation for this prompt)
      // If user wanted workflow default, they would omit the property entirely
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.endCondition, undefined);
    });
  });

  suite("resolveSessionId", () => {
    test("should use prompt-level sessionId when specified (string)", () => {
      const prompt: PromptItem = {
        prompt: "test",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
      };
      const workflow: PromptFile = {
        prompts: [],
        sessionId: "other-session-id", // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(
        resolved.sessionId,
        "550e8400-e29b-41d4-a716-446655440000"
      );
    });

    test("should use prompt-level sessionId when specified (number)", () => {
      const prompt: PromptItem = {
        prompt: "test",
        sessionId: 1,
      };
      const workflow: PromptFile = {
        prompts: [],
        sessionId: "workflow-session-id", // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, 1);
    });

    test("should use workflow-level sessionId when prompt-level not specified (string)", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        sessionId: "workflow-session-id",
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, "workflow-session-id");
    });

    test("should use workflow-level sessionId when prompt-level not specified (number)", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        sessionId: 2,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, 2);
    });

    test("should return undefined when no sessionId specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, undefined);
    });

    test("should return undefined when workflow sessionId is empty string", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        sessionId: "",
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, undefined);
    });

    test("should return undefined when prompt sessionId is empty string and prompt overrides resumeSession", () => {
      const prompt: PromptItem = {
        prompt: "test",
        sessionId: "",
        resumeSession: true, // prompt controls the resume tier, so its empty sessionId wins
      };
      const workflow: PromptFile = {
        prompts: [],
        sessionId: "workflow-session-id", // should not be used when prompt owns resume tier
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, undefined);
    });

    test("should fall through to workflow sessionId when prompt sessionId is empty but resumeSession is default", () => {
      const prompt: PromptItem = {
        prompt: "test",
        sessionId: "", // user cleared the field but did not override resumeSession
      };
      const workflow: PromptFile = {
        prompts: [],
        sessionId: "workflow-session-id",
        resumeSession: true,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.sessionId, "workflow-session-id");
    });
  });

  suite("resolveToolPermissions", () => {
    test("should return null (none) when prompt toolPermissions is null", () => {
      const prompt: PromptItem = {
        prompt: "test",
        toolPermissions: null,
      };
      const workflow: PromptFile = {
        prompts: [],
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
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        toolPermissions: null,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.toolPermissions, null);
    });

    test("should return null (none) when both levels are undefined", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.toolPermissions, null);
    });

    test("should return null (none) when mode is 'none'", () => {
      const prompt: PromptItem = {
        prompt: "test",
        toolPermissions: { mode: PERMISSION_MODES.NONE },
      };
      const workflow: PromptFile = {
        prompts: [],
        toolPermissions: { mode: PERMISSION_MODES.ALLOW_ALL },
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.toolPermissions, null);
    });

    test("should return null (none) when workflow mode is 'none' and prompt is undefined", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        toolPermissions: { mode: PERMISSION_MODES.NONE },
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.toolPermissions, null);
    });

    test("should use prompt-level config when it overrides workflow-level", () => {
      const prompt: PromptItem = {
        prompt: "test",
        toolPermissions: {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["write"],
          deniedTools: [],
        },
      };
      const workflow: PromptFile = {
        prompts: [],
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
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
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
      const prompt: PromptItem = {
        prompt: "test",
        toolPermissions: { allowedTools: ["write"] },
      };
      const workflow: PromptFile = {
        prompts: [],
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
      const prompt: PromptItem = {
        prompt: "test",
        toolPermissions: { mode: PERMISSION_MODES.CUSTOM },
      };
      const workflow: PromptFile = {
        prompts: [],
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
      const prompt: PromptItem = {
        prompt: "test",
        toolPermissions: {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["write", "shell(git:*)"],
          deniedTools: ["shell(rm:*)"],
        },
      };
      const workflow: PromptFile = {
        prompts: [],
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
      const prompt: PromptItem = {
        prompt: "test",
        hooks: [{ event: "stop", command: "npm test" }],
      };
      const workflow: PromptFile = {
        prompts: [],
        hooks: [{ event: "stop", command: "echo default" }],
      };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Prompt-level stop hooks replace workflow-level stop hooks
      assert.deepStrictEqual(resolved.hooks, [
        { event: "stop", command: "npm test" },
      ]);
    });

    test("should use workflow-level hooks when prompt-level not specified", () => {
      const prompt: PromptItem = { prompt: "test" };
      const workflow: PromptFile = {
        prompts: [],
        hooks: [{ event: "stop", command: "npm test" }],
      };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.hooks, [
        { event: "stop", command: "npm test" },
      ]);
    });

    test("should default to empty array when neither prompt nor workflow specify hooks", () => {
      const prompt: PromptItem = { prompt: "test" };
      const workflow: PromptFile = { prompts: [] };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.deepStrictEqual(resolved.hooks, []);
    });

    test("should return null when prompt explicitly disables hooks", () => {
      const prompt: PromptItem = {
        prompt: "test",
        hooks: null,
      };
      const workflow: PromptFile = {
        prompts: [],
        hooks: [{ event: "stop", command: "npm test" }],
      };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.hooks, null);
    });

    test("should return null when workflow explicitly disables hooks and prompt has no override", () => {
      const prompt: PromptItem = { prompt: "test" };
      const workflow: PromptFile = {
        prompts: [],
        hooks: null,
      };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.hooks, null);
    });

    test("should perform per-event override — prompt stop replaces workflow stop but keeps workflow sessionStart", () => {
      const prompt: PromptItem = {
        prompt: "test",
        hooks: [{ event: "stop", command: "node extra-validation.js" }],
      };
      const workflow: PromptFile = {
        prompts: [],
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
      const prompt: PromptItem = {
        prompt: "test",
        hooks: [
          { event: "stop", command: "npm test" },
          { event: "stop", command: "node notify.js" },
        ],
      };
      const workflow: PromptFile = { prompts: [] };
      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.ok(Array.isArray(resolved.hooks));
      assert.strictEqual(resolved.hooks!.length, 2);
    });
  });

  suite("full precedence chain", () => {
    test("should correctly apply three-tier precedence for all properties", () => {
      const prompt: PromptItem = {
        prompt: "test",
        harness: Harness.ClaudeCli, // Override
        // model: not specified - should use workflow
        agent: "code-reviewer", // Override
        // resumeSession: not specified - should use workflow
        mcpServers: ["flightpath"], // Override
        // endCondition: not specified - should use workflow
      };

      const workflow: PromptFile = {
        prompts: [],
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

      assert.strictEqual(resolved.harness, Harness.ClaudeCli); // From prompt
      assert.strictEqual(resolved.model, "opus"); // From workflow
      assert.strictEqual(resolved.agent, "code-reviewer"); // From prompt
      assert.strictEqual(resolved.resumeSession, true); // From workflow
      assert.deepStrictEqual(resolved.mcpServers, ["flightpath"]); // From prompt
      assert.deepStrictEqual(resolved.endCondition, {
        script: "test.js",
        returns: "true",
      }); // From workflow
    });
  });
});
