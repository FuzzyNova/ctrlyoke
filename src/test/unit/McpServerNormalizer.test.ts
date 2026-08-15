import * as assert from "assert";
import { suite, test } from "mocha";
import { EXECUTION_MODES, HARNESS_IDS } from "../../types/DashboardConstants";
import type { McpServerConfig } from "../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";
import type { ManagedMcpServer } from "../../types/WebviewMessageTypes";
import { CliProviderUtils } from "../../core/harness/shared/CliProviderUtils";
import { McpServerNormalizer } from "../../utils/McpServerNormalizer";

const PLAYWRIGHT_SERVER: McpServerConfig = {
  id: "playwright",
  command: "node",
  args: ["playwright-server.js"],
  env: { PLAYWRIGHT_MODE: "test" },
};

const MANAGED_SERVERS: ManagedMcpServer[] = [
  {
    id: PLAYWRIGHT_SERVER.id,
    displayName: "Playwright",
    config: PLAYWRIGHT_SERVER,
    locations: [],
  },
];

function createProperties(
  mcpServers: (string | McpServerConfig)[] | null
): ResolvedProperties {
  return {
    harness: HARNESS_IDS.CLAUDE_CLI,
    model: "model",
    executionMode: EXECUTION_MODES.HEADLESS,
    resumeSession: false,
    mcpServers,
    hooks: null,
    toolPermissions: null,
  };
}

suite("McpServerNormalizer", () => {
  test("resolves bare registry IDs into configs used by MCP planning", async () => {
    const normalized = await McpServerNormalizer.apply(
      createProperties(["playwright"]),
      MANAGED_SERVERS
    );
    assert.deepStrictEqual(normalized.mcpServers, [PLAYWRIGHT_SERVER]);

    let plannedServers: McpServerConfig[] | undefined;
    await CliProviderUtils.planMcpConfigBlock(
      {
        promptIndex: 0,
        allPrompts: [],
        resolvedProperties: normalized,
      },
      "/workspace",
      "/extension",
      async (
        _serverPath,
        _workspaceRoot,
        _workingFilePath,
        _env,
        userServers
      ) => {
        plannedServers = userServers;
        return { cliArgs: [], mutations: [], diagnostics: [] };
      }
    );

    assert.deepStrictEqual(plannedServers, [PLAYWRIGHT_SERVER]);
    assert.deepStrictEqual(
      CliProviderUtils.buildSettingsJsonMcpEntries(
        undefined,
        "/workspace",
        undefined,
        undefined,
        plannedServers
      ).playwright,
      {
        command: "node",
        args: ["playwright-server.js"],
        env: { PLAYWRIGHT_MODE: "test" },
      }
    );
  });

  test("keeps the ctrlyoke sentinel as a string", async () => {
    const normalized = await McpServerNormalizer.apply(
      createProperties(["ctrlyoke"]),
      MANAGED_SERVERS
    );
    assert.deepStrictEqual(normalized.mcpServers, ["ctrlyoke"]);
  });

  test("drops unknown IDs without throwing", async () => {
    const normalized = await McpServerNormalizer.apply(
      createProperties(["missing"]),
      MANAGED_SERVERS
    );
    assert.deepStrictEqual(normalized.mcpServers, []);
  });

  test("preserves an explicit null MCP override", async () => {
    const properties = createProperties(null);
    assert.strictEqual(
      await McpServerNormalizer.apply(properties, MANAGED_SERVERS),
      properties
    );
  });
});
