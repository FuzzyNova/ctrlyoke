import * as assert from "assert";
import { suite, test } from "mocha";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import { EXECUTION_MODES, HARNESS_IDS } from "../../types/DashboardConstants";
import type { PromptStep } from "../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";

function createProperties(
  mcpServers: ResolvedProperties["mcpServers"] = ["ctrlyoke"]
): ResolvedProperties {
  return {
    harness: HARNESS_IDS.COPILOT_CLI,
    model: "test-model",
    executionMode: EXECUTION_MODES.HEADLESS,
    resumeSession: false,
    mcpServers,
    hooks: null,
    toolPermissions: null,
  };
}

suite("CopilotCliProvider", () => {
  const mcpServerCases: Array<
    [string, NonNullable<ResolvedProperties["mcpServers"]>]
  > = [
    ["string form", ["ctrlyoke"]],
    ["object form", [{ id: "ctrlyoke" }]],
    [
      "object form with denied tools",
      [{ id: "ctrlyoke", deniedTools: ["append_step"] }],
    ],
  ];
  for (const [description, mcpServers] of mcpServerCases) {
    test(`auto-approves ctrlyoke MCP tools with ${description}`, async () => {
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
          resolvedProperties: createProperties(mcpServers),
        }
      );

      const allowedToolIndex = preparation.cliArgs.indexOf("--allow-tool");
      assert.strictEqual(preparation.cliArgs[allowedToolIndex + 1], "ctrlyoke");
    });
  }
});
