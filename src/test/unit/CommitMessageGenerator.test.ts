import * as assert from "assert";
import { suite, test } from "mocha";
import {
  buildCommitWorkflowOverrides,
  CommitMessageGenerationError,
} from "../../git/CommitMessageGenerator";
import { EXECUTION_MODES, HARNESS_IDS } from "../../types/DashboardConstants";
import type {
  McpServerConfig,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";

suite("CommitMessageGenerator", () => {
  test("carries the persisted run address on generation errors", () => {
    const workflowKey =
      "commit-message-generation-20260824-120000" as WorkflowKey;
    const runRef = "run-20260824-120000" as RunRef;
    const error = new CommitMessageGenerationError(
      "generation failed",
      workflowKey,
      runRef
    );

    assert.strictEqual(error.message, "generation failed");
    assert.strictEqual(error.workflowKey, workflowKey);
    assert.strictEqual(error.runRef, runRef);
    assert.strictEqual(error.name, "CommitMessageGenerationError");
  });

  test("forces its one-shot workflow to headless mode", () => {
    const mcpServer: McpServerConfig = {
      id: "ctrlyoke-commit",
      command: "node",
      args: ["mcp-server.js"],
    };

    const overrides = buildCommitWorkflowOverrides(
      HARNESS_IDS.OPENCODE_CLI,
      "test-model",
      mcpServer
    );

    assert.strictEqual(overrides.executionMode, EXECUTION_MODES.HEADLESS);
    assert.strictEqual(overrides.resumeSession, false);
    assert.strictEqual(overrides.worktree, false);
    assert.strictEqual(overrides.harness, HARNESS_IDS.OPENCODE_CLI);
    assert.strictEqual(overrides.model, "test-model");
    assert.deepStrictEqual(overrides.mcpServers, [mcpServer]);
    assert.strictEqual(overrides.agent, null);
    assert.strictEqual(overrides.skills, null);
    assert.strictEqual(overrides.additionalArgs, null);
    assert.strictEqual(overrides.hooks, null);
  });

  test("explicitly disables inherited MCP servers without capture", () => {
    const overrides = buildCommitWorkflowOverrides(
      HARNESS_IDS.COPILOT_CLI,
      undefined,
      undefined
    );

    assert.strictEqual(overrides.executionMode, EXECUTION_MODES.HEADLESS);
    assert.strictEqual(overrides.worktree, false);
    assert.strictEqual(overrides.mcpServers, null);
  });
});
