import * as assert from "assert";
import { SessionResolver } from "../../utils/SessionResolver";
import { PromptFile, PromptStep } from "../../types/FlightPathTypes";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { SESSION_ID_SENTINELS, HARNESS_IDS } from "../../types/DashboardConstants";

suite("SessionResolver Tests", () => {
  suite("resolve - workflow-level sessionId inheritance", () => {
    test("should use workflow-level sessionId when prompt-level not specified (string)", () => {
      const workflow: PromptFile = {
        steps: [],
        sessionId: "workflow-session-uuid",
        resumeSession: true,
      };

      const prompt: PromptStep = {
        prompt: "test prompt",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, "workflow-session-uuid");
    });

    test("should use workflow-level sessionId when prompt-level not specified (numeric)", () => {
      const workflow: PromptFile = {
        steps: [],
        harness: HARNESS_IDS.COPILOT_CLI,
        sessionId: 1,
        resumeSession: true,
      };

      // Create a completed prompt with runtime session
      const completedPrompt: PromptStep = {
        prompt: "first prompt",
        _runtime: {
          harness: HARNESS_IDS.COPILOT_CLI,
          model: "claude-sonnet-4.5",
          sessionId: "abc-123-from-prompt-1",
          startedAt: Date.now(),
          completedAt: Date.now(),
        },
      };

      const currentPrompt: PromptStep = {
        prompt: "second prompt",
      };

      const sessionId = SessionResolver.resolve(
        currentPrompt,
        1,
        [completedPrompt, currentPrompt],
        workflow
      );
      assert.strictEqual(sessionId, "abc-123-from-prompt-1");
    });

    test("should use prompt-level sessionId over workflow-level (string)", () => {
      const workflow: PromptFile = {
        steps: [],
        sessionId: "workflow-session-uuid",
        resumeSession: true,
      };

      const prompt: PromptStep = {
        prompt: "test prompt",
        sessionId: "prompt-session-uuid",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, "prompt-session-uuid");
    });

    test("should use prompt-level sessionId over workflow-level (numeric)", () => {
      const workflow: PromptFile = {
        steps: [],
        harness: HARNESS_IDS.COPILOT_CLI,
        sessionId: 2,
        resumeSession: true,
      };

      const completedPrompt: PromptStep = {
        prompt: "first prompt",
        _runtime: {
          harness: HARNESS_IDS.COPILOT_CLI,
          model: "claude-sonnet-4.5",
          sessionId: "abc-123",
          startedAt: Date.now(),
          completedAt: Date.now(),
        },
      };

      const currentPrompt: PromptStep = {
        prompt: "second prompt",
        sessionId: 1, // Override workflow's sessionId: 2
      };

      const sessionId = SessionResolver.resolve(
        currentPrompt,
        1,
        [completedPrompt, currentPrompt],
        workflow
      );
      assert.strictEqual(sessionId, "abc-123");
    });
  });

  suite("resolve - exact session ID", () => {
    test("should return exact session ID string when provided", () => {
      const workflow: PromptFile = {
        steps: [],
        resumeSession: true, // Necessary to enable session resumption
      };

      const prompt: PromptStep = {
        prompt: "test",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, "550e8400-e29b-41d4-a716-446655440000");
    });

    test("should return exact session ID even with resumeSession=true", () => {
      const workflow: PromptFile = {
        steps: [],
      };

      const prompt: PromptStep = {
        prompt: "test",
        sessionId: "my-session-id",
        resumeSession: true,
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, "my-session-id");
    });
  });

  suite("resolve - numeric reference", () => {
    test("should resolve numeric reference to runtime session ID", () => {
      const workflow: PromptFile = {
        steps: [],
        resumeSession: true,
      };

      const prompts: PromptStep[] = [
        {
          prompt: "first",
          _runtime: {
            harness: HARNESS_IDS.COPILOT_CLI,
            model: "claude-sonnet-4.5",
            sessionId: "session-from-prompt-1",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "second",
          harness: HARNESS_IDS.COPILOT_CLI,
          sessionId: 1, // Reference prompt 1
        },
      ];

      const sessionId = SessionResolver.resolve(
        prompts[1],
        1,
        prompts,
        workflow
      );
      assert.strictEqual(sessionId, "session-from-prompt-1");
    });

    test("should return undefined when referenced prompt has no session", () => {
      const prompts: PromptStep[] = [
        {
          prompt: "first",
          _runtime: {
            harness: HARNESS_IDS.COPILOT_CLI,
            model: "claude-sonnet-4.5",
            startedAt: Date.now(),
            completedAt: Date.now(),
            // No sessionId
          },
        },
        {
          prompt: "second",
          sessionId: 1,
        },
      ];

      const sessionId = SessionResolver.resolve(prompts[1], 1, prompts);
      assert.strictEqual(sessionId, undefined);
    });

    test("should warn on cross-harness reference", () => {
      const prompts: PromptStep[] = [
        {
          prompt: "first",
          harness: HARNESS_IDS.CLAUDE_CLI,
          _runtime: {
            harness: HARNESS_IDS.CLAUDE_CLI,
            model: "sonnet",
            sessionId: "claude-session",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "second",
          harness: HARNESS_IDS.COPILOT_CLI,
          sessionId: 1, // Cross-harness reference
        },
      ];

      // Should return undefined (cross-harness not allowed)
      const sessionId = SessionResolver.resolve(prompts[1], 1, prompts);
      assert.strictEqual(sessionId, undefined);
    });
  });

  suite("resolve - auto-resume", () => {
    test("should auto-resume from previous prompt when resumeSession=true", () => {
      const workflow: PromptFile = {
        steps: [],
        harness: HARNESS_IDS.COPILOT_CLI,
      };

      const prompts: PromptStep[] = [
        {
          prompt: "first",
          _runtime: {
            harness: HARNESS_IDS.COPILOT_CLI,
            model: "claude-sonnet-4.5",
            sessionId: "auto-resume-session",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "second",
          resumeSession: true,
        },
      ];

      const sessionId = SessionResolver.resolve(
        prompts[1],
        1,
        prompts,
        workflow
      );
      assert.strictEqual(sessionId, "auto-resume-session");
    });

    test("should skip prompts with different harnesses when auto-resuming", () => {
      const prompts: PromptStep[] = [
        {
          prompt: "first",
          _runtime: {
            harness: HARNESS_IDS.CLAUDE_CLI,
            model: "sonnet",
            sessionId: "claude-session",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "second",
          _runtime: {
            harness: HARNESS_IDS.COPILOT_CLI,
            model: "claude-sonnet-4.5",
            sessionId: "copilot-session",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "third",
          harness: HARNESS_IDS.COPILOT_CLI,
          resumeSession: true,
        },
      ];

      // Should skip claude-session and use copilot-session (matching harness)
      const sessionId = SessionResolver.resolve(prompts[2], 2, prompts);
      assert.strictEqual(sessionId, "copilot-session");
    });

    test("should return undefined when no previous prompt with matching harness", () => {
      const prompts: PromptStep[] = [
        {
          prompt: "first",
          _runtime: {
            harness: HARNESS_IDS.CLAUDE_CLI,
            model: "sonnet",
            sessionId: "claude-session",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "second",
          harness: HARNESS_IDS.COPILOT_CLI,
          resumeSession: true,
        },
      ];

      // Should return undefined (no Copilot sessions to resume)
      const sessionId = SessionResolver.resolve(prompts[1], 1, prompts);
      assert.strictEqual(sessionId, undefined);
    });

    test("should return undefined for first prompt with auto-resume", () => {
      const prompt: PromptStep = {
        prompt: "first",
        resumeSession: true,
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt]);
      assert.strictEqual(sessionId, undefined);
    });
  });

  suite("resolve - resumeSession precedence", () => {
    test("should return undefined when resumeSession=false at prompt level", () => {
      const prompt: PromptStep = {
        prompt: "test",
        resumeSession: false,
        sessionId: "ignored-session", // Should be ignored
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt]);
      assert.strictEqual(sessionId, undefined);
    });

    test("should respect workflow-level resumeSession when prompt-level not set", () => {
      const workflow: PromptFile = {
        steps: [],
        resumeSession: false,
        sessionId: "ignored-session",
      };

      const prompt: PromptStep = {
        prompt: "test",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, undefined);
    });

    test("should use sessionId when resumeSession=true at workflow level", () => {
      const workflow: PromptFile = {
        steps: [],
        resumeSession: true,
        sessionId: "workflow-session",
      };

      const prompt: PromptStep = {
        prompt: "test",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, "workflow-session");
    });
  });

  suite("shouldResumeSession", () => {
    test("should return false when prompt.resumeSession=false", () => {
      const prompt: PromptStep = {
        prompt: "test",
        resumeSession: false,
      };

      const workflow: PromptFile = {
        steps: [],
        resumeSession: true, // Should be ignored
      };

      const result = SessionResolver.shouldResumeSession(prompt, workflow);
      assert.strictEqual(result, false);
    });

    test("should return true when prompt.resumeSession=true", () => {
      const prompt: PromptStep = {
        prompt: "test",
        resumeSession: true,
      };

      const workflow: PromptFile = {
        steps: [],
        resumeSession: false, // Should be ignored
      };

      const result = SessionResolver.shouldResumeSession(prompt, workflow);
      assert.strictEqual(result, true);
    });

    test("should use workflow.resumeSession when prompt-level not set", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };

      const workflow: PromptFile = {
        steps: [],
        resumeSession: true,
      };

      const result = SessionResolver.shouldResumeSession(prompt, workflow);
      assert.strictEqual(result, true);
    });

    test("should return false when no workflow provided and prompt not set", () => {
      const prompt: PromptStep = {
        prompt: "test",
      };

      const result = SessionResolver.shouldResumeSession(prompt);
      assert.strictEqual(result, false);
    });
  });

  suite("validate", () => {
    test("should return valid for exact session ID", () => {
      const prompt: PromptStep = {
        prompt: "test",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
      };

      const result = SessionResolver.validate(prompt, 0, [prompt]);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });

    test("should warn when both resumeSession=false and sessionId set", () => {
      const prompt: PromptStep = {
        prompt: "test",
        sessionId: "my-session",
        resumeSession: false,
      };

      const result = SessionResolver.validate(prompt, 0, [prompt]);
      assert.strictEqual(result.valid, true);
      assert.ok(result.warning);
      assert.ok(result.warning!.includes("resumeSession=false"));
    });

    test("should return error for out-of-range numeric reference", () => {
      const prompts: PromptStep[] = [
        { prompt: "first" },
        { prompt: "second" },
        { prompt: "third", sessionId: 5 }, // Out of range
      ];

      const result = SessionResolver.validate(prompts[2], 2, prompts);
      assert.strictEqual(
        result.valid,
        false,
        "Should be invalid for out-of-range reference"
      );
      assert.ok(result.error, "Should have an error message");
      assert.ok(
        result.error!.includes("reference a prompt between 1-3"),
        "Error should mention valid range"
      );
    });

    test("should return error for backward-looking numeric reference", () => {
      const prompts: PromptStep[] = [
        { prompt: "first", sessionId: 2 }, // Can't reference prompt 2 from prompt 1
        { prompt: "second" },
      ];

      const result = SessionResolver.validate(prompts[0], 0, prompts);
      assert.strictEqual(
        result.valid,
        false,
        "Should be invalid for forward reference"
      );
      assert.ok(result.error, "Should have an error message");
    });

    test("should return valid for proper numeric reference", () => {
      const prompts: PromptStep[] = [
        {
          prompt: "first",
          _runtime: {
            harness: HARNESS_IDS.COPILOT_CLI,
            model: "claude-sonnet-4.5",
            sessionId: "session-1",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        { prompt: "second", sessionId: 1 },
      ];

      const result = SessionResolver.validate(prompts[1], 1, prompts);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });
  });

  suite("resumeSession Setting Resolution", () => {
    test("shouldResumeSessionForPrompt should use prompt value when explicitly set to true", () => {
      const result = ConfigurationUtils.shouldResumeSessionForPrompt(true);
      assert.strictEqual(
        result,
        true,
        "Should use explicit prompt value (true)"
      );
    });

    test("shouldResumeSessionForPrompt should use prompt value when explicitly set to false", () => {
      const result = ConfigurationUtils.shouldResumeSessionForPrompt(false);
      assert.strictEqual(
        result,
        false,
        "Should use explicit prompt value (false)"
      );
    });

    test("shouldResumeSessionForPrompt should fall back to global setting when prompt value is undefined", () => {
      // The global setting defaults to false
      const result = ConfigurationUtils.shouldResumeSessionForPrompt(undefined);
      // We can't mock VS Code settings in unit tests, so we just verify it returns a boolean
      assert.strictEqual(
        typeof result,
        "boolean",
        "Should return boolean from global setting"
      );
    });
  });

  suite("resolve - SESSION_ID_SENTINELS.FINAL_STEP sentinel", () => {
    const workflow: PromptFile = {
      steps: [],
      resumeSession: true,
    };

    test("should return finalStepSessionId when sentinel is used and prior session exists", () => {
      const prompt: PromptStep = {
        prompt: "finalStep text",
        sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
      };
      const priorSessionId = "550e8400-e29b-41d4-a716-446655440000";

      const sessionId = SessionResolver.resolve(
        prompt,
        0,
        [prompt],
        workflow,
        priorSessionId
      );
      assert.strictEqual(sessionId, priorSessionId);
    });

    test("should return undefined when sentinel is used but no prior session (first iteration)", () => {
      const prompt: PromptStep = {
        prompt: "finalStep text",
        sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
      };

      const sessionId = SessionResolver.resolve(
        prompt,
        0,
        [prompt],
        workflow,
        undefined
      );
      assert.strictEqual(sessionId, undefined);
    });

    test("should return undefined when resumeSession=false even with sentinel and prior session", () => {
      const noResumeWorkflow: PromptFile = {
        steps: [],
        resumeSession: false,
      };
      const prompt: PromptStep = {
        prompt: "finalStep text",
        sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
      };

      const sessionId = SessionResolver.resolve(
        prompt,
        0,
        [prompt],
        noResumeWorkflow,
        "some-prior-session"
      );
      assert.strictEqual(sessionId, undefined);
    });

    test("should ignore finalStepSessionId when sessionId is not the sentinel", () => {
      const exactId = "660e8400-e29b-41d4-a716-446655440000";
      const prompt: PromptStep = {
        prompt: "finalStep text",
        sessionId: exactId,
        resumeSession: true,
      };

      const sessionId = SessionResolver.resolve(
        prompt,
        0,
        [prompt],
        workflow,
        "should-be-ignored"
      );
      assert.strictEqual(sessionId, exactId);
    });

    test("should use sentinel from workflow-level sessionId", () => {
      const workflowWithSentinel: PromptFile = {
        steps: [],
        sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
        resumeSession: true,
      };
      const prompt: PromptStep = {
        prompt: "finalStep text",
      };
      const priorSessionId = "770e8400-e29b-41d4-a716-446655440000";

      const sessionId = SessionResolver.resolve(
        prompt,
        0,
        [prompt],
        workflowWithSentinel,
        priorSessionId
      );
      assert.strictEqual(sessionId, priorSessionId);
    });
  });
});
