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

  test("qualifies MCP autoApprove tool names with their server ID", async () => {
    const provider = new CopilotCliProvider();
    const preparation = await provider.planCliArgs(
      { prompt: "create an issue" } as PromptStep,
      false,
      process.cwd(),
      process.cwd(),
      undefined,
      {
        promptIndex: 0,
        allPrompts: [],
        resolvedProperties: createProperties([
          { id: "github", command: "npx", autoApprove: ["create_issue"] },
        ]),
      }
    );

    assert.ok(
      preparation.cliArgs.some(
        (arg, index, args) =>
          arg === "--allow-tool" && args[index + 1] === "github(create_issue)"
      )
    );
  });

  test("never emits a bare built-in permission for an MCP autoApprove tool", async () => {
    const provider = new CopilotCliProvider();
    const preparation = await provider.planCliArgs(
      { prompt: "write" } as PromptStep,
      false,
      process.cwd(),
      process.cwd(),
      undefined,
      {
        promptIndex: 0,
        allPrompts: [],
        resolvedProperties: createProperties([
          { id: "github", command: "npx", autoApprove: ["write"] },
        ]),
      }
    );

    for (let index = 0; index < preparation.cliArgs.length; index++) {
      if (preparation.cliArgs[index] === "--allow-tool") {
        assert.notStrictEqual(preparation.cliArgs[index + 1], "write");
      }
    }
  });

  test("uses a unique OTel path per invocation and cleans up every path", async () => {
    const provider = new CopilotCliProvider();
    const plan = () =>
      provider.planCliArgs(
        { prompt: "use the queue" } as PromptStep,
        false,
        process.cwd(),
        process.cwd(),
        undefined,
        {
          promptIndex: 3,
          allPrompts: [],
          workingFilePath: "workflow.ctrlyoke.json",
          resolvedProperties: createProperties(),
        }
      );
    const first = await plan();
    for (const mutation of first.mutations) await mutation.apply();
    const firstPath = provider.getHeadlessSpawnEnv()
      .COPILOT_OTEL_FILE_EXPORTER_PATH;

    const second = await plan();
    for (const mutation of second.mutations) await mutation.apply();
    const secondPath = provider.getHeadlessSpawnEnv()
      .COPILOT_OTEL_FILE_EXPORTER_PATH;

    assert.ok(firstPath);
    assert.ok(secondPath);
    assert.notStrictEqual(firstPath, secondPath);
    const cleanupPaths = provider.getAdditionalCleanupFilePaths(process.cwd());
    assert.ok(cleanupPaths.includes(firstPath));
    assert.ok(cleanupPaths.includes(secondPath));
  });
});
