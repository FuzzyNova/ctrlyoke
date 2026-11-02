import * as assert from "assert";
import { suite, test } from "mocha";
import { CliSessionResolverAdapter } from "../../core/harness/shared/CliSessionResolverAdapter";
import type { ICliProvider } from "../../core/harness/shared/interfaces/ICliProvider";
import { type PromptFile, type PromptStep } from "../../types/CtrlYokeTypes";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import type { WorkflowContext } from "../../types/WorkflowContextTypes";

suite("CliSessionResolverAdapter", () => {
  test("should resolve workflow properties and auto-resumed session IDs", async () => {
    const adapter = new CliSessionResolverAdapter({
      getIntegrationHarness: () => HARNESS_IDS.COPILOT_CLI,
      provider: {} as ICliProvider,
      getWorkspaceRoot: () => "/workspace",
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

    const result = await adapter.resolve(currentPrompt, {
      promptIndex: 1,
      allPrompts: [previousPrompt, currentPrompt],
      workflowFile,
    } as WorkflowContext);

    assert.strictEqual(
      result.resolvedSessionId,
      "550e8400-e29b-41d4-a716-446655440000"
    );
    assert.strictEqual(
      result.resolvedProperties?.harness,
      HARNESS_IDS.COPILOT_CLI
    );
    assert.strictEqual(result.resolvedProperties?.model, "gpt-5");
  });

  test("should clear invalid session IDs and explain the fallback", async () => {
    const adapter = new CliSessionResolverAdapter({
      getIntegrationHarness: () => HARNESS_IDS.CLAUDE_CLI,
      provider: {} as ICliProvider,
      getWorkspaceRoot: () => "/workspace",
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

    const result = await adapter.resolve(prompt, {
      promptIndex: 0,
      allPrompts: [prompt],
      workflowFile,
    } as WorkflowContext);

    assert.strictEqual(result.resolvedSessionId, undefined);
    assert.match(result.warningMessage ?? "", /not valid/);
  });

  test("preflights a resolved ID and clears only a confirmed missing session", async () => {
    const adapter = new CliSessionResolverAdapter({
      getIntegrationHarness: () => HARNESS_IDS.COPILOT_CLI,
      provider: {
        probeResumableSession: async () => "missing",
      } as unknown as ICliProvider,
      getWorkspaceRoot: () => "/workspace",
    });
    const prompt: PromptStep = {
      prompt: "continue",
      resumeSession: true,
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    };
    const result = await adapter.resolve(prompt, {
      promptIndex: 0,
      allPrompts: [prompt],
      preflightSession: {
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
      },
      resolvedProperties: {
        harness: HARNESS_IDS.COPILOT_CLI,
        model: "test-model",
        resumeSession: true,
        mcpServers: null,
        hooks: null,
        toolPermissions: null,
      },
    } as WorkflowContext);
    assert.strictEqual(result.resolvedSessionId, undefined);
    assert.match(result.warningMessage ?? "", /Step 1/);
    assert.match(result.warningMessage ?? "", /not found on this machine/);
  });

  test("should return workflowContext resolved properties when no workflow file exists", async () => {
    const adapter = new CliSessionResolverAdapter({
      getIntegrationHarness: () => HARNESS_IDS.CODEX_CLI,
      provider: {} as ICliProvider,
      getWorkspaceRoot: () => "/workspace",
    });

    const prompt: PromptStep = {
      prompt: "continue",
    };

    const result = await adapter.resolve(prompt, {
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
    assert.strictEqual(
      result.resolvedProperties?.harness,
      HARNESS_IDS.CODEX_CLI
    );
    assert.strictEqual(result.resolvedProperties?.model, "gpt-5.2-codex");
  });
});
