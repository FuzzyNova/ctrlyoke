import * as assert from "assert";
import { suite, test } from "mocha";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import { EXECUTION_MODES, HARNESS_IDS } from "../../types/DashboardConstants";
import type { PromptStep } from "../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";

function createProperties(): ResolvedProperties {
  return {
    harness: HARNESS_IDS.COPILOT_CLI,
    model: "test-model",
    executionMode: EXECUTION_MODES.HEADLESS,
    resumeSession: false,
    mcpServers: ["ctrlyoke"],
    hooks: null,
    toolPermissions: null,
  };
}

suite("CopilotCliProvider", () => {
  test("keeps the ctrlyoke MCP auto-approval sentinel as a string", async () => {
    const provider = new CopilotCliProvider();
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

    const allowedToolIndex = preparation.cliArgs.indexOf("--allow-tool");
    assert.strictEqual(preparation.cliArgs[allowedToolIndex + 1], "ctrlyoke");
  });
});
