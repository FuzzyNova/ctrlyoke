import * as assert from "assert";
import { SessionResolver } from "../../utils/SessionResolver";
import { PromptFile, PromptItem, Harness } from "../../types/FlightPathTypes";

suite("SessionResolver Tests", () => {
  suite("resolve - workflow-level sessionId inheritance", () => {
    test("should use workflow-level sessionId when prompt-level not specified (string)", () => {
      const workflow: PromptFile = {
        prompts: [],
        sessionId: "workflow-session-uuid",
        resumeSession: true,
      };

      const prompt: PromptItem = {
        prompt: "test prompt",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, "workflow-session-uuid");
    });

    test("should use workflow-level sessionId when prompt-level not specified (numeric)", () => {
      const workflow: PromptFile = {
        prompts: [],
        sessionId: 1,
        resumeSession: true,
      };

      // Create a completed prompt with runtime session
      const completedPrompt: PromptItem = {
        prompt: "first prompt",
        _runtime: {
          harness: Harness.CopilotCli,
          model: "claude-sonnet-4.5",
          sessionId: "abc-123-from-prompt-1",
          startedAt: Date.now(),
          completedAt: Date.now(),
        },
      };

      const currentPrompt: PromptItem = {
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
        prompts: [],
        sessionId: "workflow-session-uuid",
        resumeSession: true,
      };

      const prompt: PromptItem = {
        prompt: "test prompt",
        sessionId: "prompt-session-uuid",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, "prompt-session-uuid");
    });

    test("should use prompt-level sessionId over workflow-level (numeric)", () => {
      const workflow: PromptFile = {
        prompts: [],
        sessionId: 2,
        resumeSession: true,
      };

      const completedPrompt: PromptItem = {
        prompt: "first prompt",
        _runtime: {
          harness: Harness.CopilotCli,
          model: "claude-sonnet-4.5",
          sessionId: "abc-123",
          startedAt: Date.now(),
          completedAt: Date.now(),
        },
      };

      const currentPrompt: PromptItem = {
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
        prompts: [],
        resumeSession: true, // Necessary to enable session resumption
      };

      const prompt: PromptItem = {
        prompt: "test",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, "550e8400-e29b-41d4-a716-446655440000");
    });

    test("should return exact session ID even with resumeSession=true", () => {
      const workflow: PromptFile = {
        prompts: [],
      };

      const prompt: PromptItem = {
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
        prompts: [],
        resumeSession: true,
      };

      const prompts: PromptItem[] = [
        {
          prompt: "first",
          _runtime: {
            harness: Harness.CopilotCli,
            model: "claude-sonnet-4.5",
            sessionId: "session-from-prompt-1",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "second",
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
      const prompts: PromptItem[] = [
        {
          prompt: "first",
          _runtime: {
            harness: Harness.CopilotCli,
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

    test("should warn on cross-provider reference", () => {
      const prompts: PromptItem[] = [
        {
          prompt: "first",
          harness: Harness.ClaudeCli,
          _runtime: {
            harness: Harness.ClaudeCli,
            model: "sonnet",
            sessionId: "claude-session",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "second",
          harness: Harness.CopilotCli,
          sessionId: 1, // Cross-provider reference
        },
      ];

      // Should return undefined (cross-provider not allowed)
      const sessionId = SessionResolver.resolve(prompts[1], 1, prompts);
      assert.strictEqual(sessionId, undefined);
    });
  });

  suite("resolve - auto-resume", () => {
    test("should auto-resume from previous prompt when resumeSession=true", () => {
      const workflow: PromptFile = {
        prompts: [],
      };

      const prompts: PromptItem[] = [
        {
          prompt: "first",
          _runtime: {
            harness: Harness.CopilotCli,
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

    test("should skip prompts with different providers when auto-resuming", () => {
      const prompts: PromptItem[] = [
        {
          prompt: "first",
          _runtime: {
            harness: Harness.ClaudeCli,
            model: "sonnet",
            sessionId: "claude-session",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "second",
          _runtime: {
            harness: Harness.CopilotCli,
            model: "claude-sonnet-4.5",
            sessionId: "copilot-session",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "third",
          harness: Harness.CopilotCli,
          resumeSession: true,
        },
      ];

      // Should skip claude-session and use copilot-session (matching provider)
      const sessionId = SessionResolver.resolve(prompts[2], 2, prompts);
      assert.strictEqual(sessionId, "copilot-session");
    });

    test("should return undefined when no previous prompt with matching provider", () => {
      const prompts: PromptItem[] = [
        {
          prompt: "first",
          _runtime: {
            harness: Harness.ClaudeCli,
            model: "sonnet",
            sessionId: "claude-session",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        },
        {
          prompt: "second",
          harness: Harness.CopilotCli,
          resumeSession: true,
        },
      ];

      // Should return undefined (no Copilot sessions to resume)
      const sessionId = SessionResolver.resolve(prompts[1], 1, prompts);
      assert.strictEqual(sessionId, undefined);
    });

    test("should return undefined for first prompt with auto-resume", () => {
      const prompt: PromptItem = {
        prompt: "first",
        resumeSession: true,
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt]);
      assert.strictEqual(sessionId, undefined);
    });
  });

  suite("resolve - resumeSession precedence", () => {
    test("should return undefined when resumeSession=false at prompt level", () => {
      const prompt: PromptItem = {
        prompt: "test",
        resumeSession: false,
        sessionId: "ignored-session", // Should be ignored
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt]);
      assert.strictEqual(sessionId, undefined);
    });

    test("should respect workflow-level resumeSession when prompt-level not set", () => {
      const workflow: PromptFile = {
        prompts: [],
        resumeSession: false,
        sessionId: "ignored-session",
      };

      const prompt: PromptItem = {
        prompt: "test",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, undefined);
    });

    test("should use sessionId when resumeSession=true at workflow level", () => {
      const workflow: PromptFile = {
        prompts: [],
        resumeSession: true,
        sessionId: "workflow-session",
      };

      const prompt: PromptItem = {
        prompt: "test",
      };

      const sessionId = SessionResolver.resolve(prompt, 0, [prompt], workflow);
      assert.strictEqual(sessionId, "workflow-session");
    });
  });

  suite("shouldResumeSession", () => {
    test("should return false when prompt.resumeSession=false", () => {
      const prompt: PromptItem = {
        prompt: "test",
        resumeSession: false,
      };

      const workflow: PromptFile = {
        prompts: [],
        resumeSession: true, // Should be ignored
      };

      const result = SessionResolver.shouldResumeSession(prompt, workflow);
      assert.strictEqual(result, false);
    });

    test("should return true when prompt.resumeSession=true", () => {
      const prompt: PromptItem = {
        prompt: "test",
        resumeSession: true,
      };

      const workflow: PromptFile = {
        prompts: [],
        resumeSession: false, // Should be ignored
      };

      const result = SessionResolver.shouldResumeSession(prompt, workflow);
      assert.strictEqual(result, true);
    });

    test("should use workflow.resumeSession when prompt-level not set", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };

      const workflow: PromptFile = {
        prompts: [],
        resumeSession: true,
      };

      const result = SessionResolver.shouldResumeSession(prompt, workflow);
      assert.strictEqual(result, true);
    });

    test("should return false when no workflow provided and prompt not set", () => {
      const prompt: PromptItem = {
        prompt: "test",
      };

      const result = SessionResolver.shouldResumeSession(prompt);
      assert.strictEqual(result, false);
    });
  });

  suite("validate", () => {
    test("should return valid for exact session ID", () => {
      const prompt: PromptItem = {
        prompt: "test",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
      };

      const result = SessionResolver.validate(prompt, 0, [prompt]);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });

    test("should warn when both resumeSession=false and sessionId set", () => {
      const prompt: PromptItem = {
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
      const prompts: PromptItem[] = [
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
      const prompts: PromptItem[] = [
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
      const prompts: PromptItem[] = [
        {
          prompt: "first",
          _runtime: {
            harness: Harness.CopilotCli,
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
});
