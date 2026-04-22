import * as assert from "assert";
import { suite, test } from "mocha";
import { CliSessionResolverAdapter } from "../../flightpath/harness/shared/CliSessionResolverAdapter";
import {
  type PromptFile,
  type PromptStep,
} from "../../types/FlightPathTypes";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import type { WorkflowContext } from "../../types/WorkflowContextTypes";
import { Log } from "../../utils/Log";

suite("CliSessionResolverAdapter", () => {
  test("should resolve workflow properties and auto-resumed session IDs", () => {
    const adapter = new CliSessionResolverAdapter({
      getIntegrationHarness: () => HARNESS_IDS.COPILOT_CLI,
    });

    const previousPrompt: PromptStep = {
      prompt: "previous",
      _runtime: {
        harness: HARNESS_IDS.COPILOT_CLI,
        model: "gpt-5",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    };
    const currentPrompt: PromptStep = {
      prompt: "current",
      resumeSession: true,
    };
    const workflowFile: PromptFile = {
      steps: [previousPrompt, currentPrompt],
      harness: HARNESS_IDS.COPILOT_CLI,
      model: "gpt-5",
      resumeSession: true,
    };

    const result = adapter.resolve(currentPrompt, {
      promptIndex: 1,
      allPrompts: [previousPrompt, currentPrompt],
      workflowFile,
    } as WorkflowContext);

    assert.strictEqual(
      result.resolvedSessionId,
      "550e8400-e29b-41d4-a716-446655440000"
    );
    assert.strictEqual(result.resolvedProperties?.harness, HARNESS_IDS.COPILOT_CLI);
    assert.strictEqual(result.resolvedProperties?.model, "gpt-5");
  });

  test("should clear invalid session IDs for the resolved harness", () => {
    const messages: string[] = [];
    const originalInfo = Log.info;
    (Log as unknown as { info(message: string): void }).info = (
      message: string
    ) => {
      messages.push(message);
    };

    try {
      const adapter = new CliSessionResolverAdapter({
        getIntegrationHarness: () => HARNESS_IDS.CLAUDE_CLI,
      });

      const prompt: PromptStep = {
        prompt: "test",
        resumeSession: true,
        sessionId: "not-a-valid-uuid",
      };
      const workflowFile: PromptFile = {
        steps: [prompt],
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "sonnet",
        resumeSession: true,
      };

      const result = adapter.resolve(prompt, {
        promptIndex: 0,
        allPrompts: [prompt],
        workflowFile,
      } as WorkflowContext);

      assert.strictEqual(result.resolvedSessionId, undefined);
      assert.deepStrictEqual(messages, [
        "🔄 Starting new session due to invalid session ID format",
      ]);
    } finally {
      (Log as unknown as { info(message: string): void }).info = originalInfo;
    }
  });

  test("should return workflowContext resolved properties when no workflow file exists", () => {
    const adapter = new CliSessionResolverAdapter({
      getIntegrationHarness: () => HARNESS_IDS.CODEX_CLI,
    });

    const prompt: PromptStep = {
      prompt: "continue",
    };

    const result = adapter.resolve(prompt, {
      promptIndex: 0,
      allPrompts: [prompt],
      resolvedProperties: {
        harness: HARNESS_IDS.CODEX_CLI,
        model: "gpt-5.2-codex",
        resumeSession: true,
        mcpServers: null,
        hooks: null,
        toolPermissions: null,
      },
    } as WorkflowContext);

    assert.strictEqual(result.resolvedSessionId, undefined);
    assert.strictEqual(result.resolvedProperties?.harness, HARNESS_IDS.CODEX_CLI);
    assert.strictEqual(result.resolvedProperties?.model, "gpt-5.2-codex");
  });
});
