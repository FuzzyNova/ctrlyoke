import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
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

  test("skips unsafe MCP autoApprove server IDs and reports diagnostics", async () => {
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
          { id: "shell", command: "npx", autoApprove: ["rm:*"] },
          { id: "write", command: "npx", autoApprove: true },
          { id: "github", command: "npx", autoApprove: ["create_issue"] },
        ]),
      }
    );

    const allowedTools = preparation.cliArgs.flatMap((arg, index, args) =>
      arg === "--allow-tool" ? [args[index + 1]] : []
    );
    assert.ok(!allowedTools.includes("shell(rm:*)"));
    assert.ok(!allowedTools.includes("write"));
    assert.ok(allowedTools.includes("github(create_issue)"));
    assert.strictEqual(preparation.diagnostics.length, 2);
    assert.match(preparation.diagnostics[0].message, /shell/);
    assert.match(preparation.diagnostics[1].message, /write/);
  });

  test("skips MCP autoApprove tool names containing permission delimiters", async () => {
    const preparation = await new CopilotCliProvider().planCliArgs(
      { prompt: "approve tool" } as PromptStep,
      false,
      process.cwd(),
      process.cwd(),
      undefined,
      {
        promptIndex: 0,
        allPrompts: [],
        resolvedProperties: createProperties([
          {
            id: "github",
            command: "npx",
            autoApprove: ["create(issue)", "a,b"],
          },
        ]),
      }
    );

    assert.ok(!preparation.cliArgs.includes("github(create(issue))"));
    assert.ok(!preparation.cliArgs.includes("github(a,b)"));
    assert.strictEqual(preparation.diagnostics.length, 2);
    assert.ok(
      preparation.diagnostics.every((diagnostic) =>
        /github/.test(diagnostic.message)
      )
    );
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
    const firstPath =
      provider.getHeadlessSpawnEnv().COPILOT_OTEL_FILE_EXPORTER_PATH;

    const second = await plan();
    for (const mutation of second.mutations) await mutation.apply();
    const secondPath =
      provider.getHeadlessSpawnEnv().COPILOT_OTEL_FILE_EXPORTER_PATH;

    assert.ok(firstPath);
    assert.ok(secondPath);
    assert.notStrictEqual(firstPath, secondPath);
    const cleanupPaths = provider.getAdditionalCleanupFilePaths(process.cwd());
    assert.ok(cleanupPaths.includes(firstPath));
    assert.ok(cleanupPaths.includes(secondPath));

    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "copilot-cleanup-")
    );
    try {
      await provider.cleanupWorkspaceArtifacts(workspaceRoot);
      assert.ok(
        !provider
          .getAdditionalCleanupFilePaths(workspaceRoot)
          .some(
            (cleanupPath) =>
              cleanupPath === firstPath || cleanupPath === secondPath
          )
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
