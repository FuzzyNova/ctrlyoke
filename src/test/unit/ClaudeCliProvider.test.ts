import * as assert from "assert";
import { suite, test } from "mocha";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { EXECUTION_MODES, HARNESS_IDS } from "../../types/DashboardConstants";
import type { PromptStep } from "../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";

function createProperties(): ResolvedProperties {
  return {
    harness: HARNESS_IDS.CLAUDE_CLI,
    model: "test-model",
    executionMode: EXECUTION_MODES.HEADLESS,
    resumeSession: false,
    mcpServers: ["ctrlyoke"],
    hooks: null,
    toolPermissions: null,
  };
}

suite("ClaudeCliProvider", () => {
  test("retains hook and statusline artifacts for reusable PTY sessions", () => {
    const provider = new ClaudeCliProvider();

    assert.strictEqual(provider.shouldRetainWorkflowArtifactsForReuse(), true);
  });

  test("keeps invalid-session spawn errors recoverable", () => {
    const provider = new ClaudeCliProvider();

    for (const message of [
      "--resume requires a valid session ID",
      "Session IDs must be in UUID format",
      "No conversation found with session ID abc",
    ]) {
      assert.strictEqual(provider.isRecoverableSessionError(message), true);
    }

    assert.strictEqual(
      provider.isRecoverableSessionError("Claude authentication failed"),
      false
    );
  });

  test("keeps the ctrlyoke MCP auto-approval sentinel as a string", async () => {
    const provider = new ClaudeCliProvider();
    const preparation = await provider.planCliArgs(
      { prompt: "use the queue" } as PromptStep,
      false,
      process.cwd(),
      process.cwd(),
      undefined,
      {
        promptIndex: 0,
        allPrompts: [],
        resolvedProperties: createProperties(),
      }
    );

    const allowedToolsIndex = preparation.cliArgs.indexOf("--allowed-tools");
    assert.strictEqual(preparation.cliArgs[allowedToolsIndex + 1], "mcp__ctrlyoke");
  });
});
