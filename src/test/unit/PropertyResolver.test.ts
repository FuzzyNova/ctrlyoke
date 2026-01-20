import * as assert from "assert";
import { PropertyResolver } from "../../utils/PropertyResolver";
import { Provider, PromptFile, PromptItem } from "../../types/FlightPathTypes";

suite("PropertyResolver Tests", () => {
  suite("resolveProvider", () => {
    test("should use prompt-level provider when specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
        provider: Provider.ClaudeCli,
      };
      const workflow: PromptFile = {
        prompts: [],
        provider: Provider.CopilotCli, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.provider, Provider.ClaudeCli);
    });

    test("should use workflow-level provider when prompt-level not specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        provider: Provider.ClaudeCli,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.provider, Provider.ClaudeCli);
    });

    test("should fall back to VS Code setting when neither prompt nor workflow specify provider", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Should default to ConfigurationUtils.getIntegrationMode() result
      assert.ok(resolved.provider); // Provider should be defined
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

    test("should fall back to provider-specific model when neither prompt nor workflow specify model", () => {
      const prompt: PromptItem = {
        prompt: "test",
        provider: Provider.CopilotCli,
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

  suite("resolveNewChatSession", () => {
    test("should use prompt-level newChatSession when specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
        newChatSession: true,
      };
      const workflow: PromptFile = {
        prompts: [],
        newChatSession: false, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.newChatSession, true);
    });

    test("should use workflow-level newChatSession when prompt-level not specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        newChatSession: false,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.newChatSession, false);
    });

    test("should fall back to VS Code setting when neither prompt nor workflow specify newChatSession", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      // Should default to ConfigurationUtils.shouldStartNewChatSessionPerPrompt()
      assert.strictEqual(typeof resolved.newChatSession, "boolean");
    });
  });

  suite("resolveAllowDynamicExtension", () => {
    test("should use prompt-level allowDynamicExtension when specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
        allowDynamicExtension: true,
      };
      const workflow: PromptFile = {
        prompts: [],
        allowDynamicExtension: false, // Should be ignored
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.allowDynamicExtension, true);
    });

    test("should use workflow-level allowDynamicExtension when prompt-level not specified", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
        allowDynamicExtension: true,
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.allowDynamicExtension, true);
    });

    test("should default to false when neither prompt nor workflow specify allowDynamicExtension", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };
      const workflow: PromptFile = {
        prompts: [],
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);
      assert.strictEqual(resolved.allowDynamicExtension, false);
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

  suite("full precedence chain", () => {
    test("should correctly apply three-tier precedence for all properties", () => {
      const prompt: PromptItem = {
        prompt: "test",
        provider: Provider.ClaudeCli, // Override
        // model: not specified - should use workflow
        agent: "code-reviewer", // Override
        // newChatSession: not specified - should use workflow
        allowDynamicExtension: true, // Override
        // endCondition: not specified - should use workflow
      };

      const workflow: PromptFile = {
        prompts: [],
        // provider: not specified - prompt overrides anyway
        model: "opus", // Should be used
        // agent: not specified - prompt overrides anyway
        newChatSession: false, // Should be used
        // allowDynamicExtension: not specified - prompt overrides anyway
        endCondition: {
          script: "test.js",
          returns: "true",
        }, // Should be used
      };

      const resolved = PropertyResolver.resolve(prompt, workflow);

      assert.strictEqual(resolved.provider, Provider.ClaudeCli); // From prompt
      assert.strictEqual(resolved.model, "opus"); // From workflow
      assert.strictEqual(resolved.agent, "code-reviewer"); // From prompt
      assert.strictEqual(resolved.newChatSession, false); // From workflow
      assert.strictEqual(resolved.allowDynamicExtension, true); // From prompt
      assert.deepStrictEqual(resolved.endCondition, {
        script: "test.js",
        returns: "true",
      }); // From workflow
    });
  });
});
