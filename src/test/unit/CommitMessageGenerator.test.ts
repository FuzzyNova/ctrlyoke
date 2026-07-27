import * as assert from "assert";
import { suite, test } from "mocha";
import { buildCommitWorkflowOverrides } from "../../git/CommitMessageGenerator";
import { EXECUTION_MODES, HARNESS_IDS } from "../../types/DashboardConstants";
import type { McpServerConfig } from "../../types/CtrlYokeTypes";

suite("CommitMessageGenerator", () => {
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
    assert.strictEqual(overrides.mcpServers, null);
  });
});
