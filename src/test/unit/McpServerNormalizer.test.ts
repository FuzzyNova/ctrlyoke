import * as assert from "assert";
import { suite, test } from "mocha";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  CTRLYOKE_MCP_MODES,
  PROMPT_DIAGNOSTIC_CODES,
  SETTING_SCOPES,
} from "../../types/DashboardConstants";
import type { McpServerConfig } from "../../types/CtrlYokeTypes";
import type { CtrlYokeMcpMode } from "../../types/DashboardConstants";
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
  mcpServers: (string | McpServerConfig)[] | null,
  ctrlyokeMcpMode?: CtrlYokeMcpMode
): ResolvedProperties {
  return {
    harness: HARNESS_IDS.CLAUDE_CLI,
    model: "model",
    executionMode: EXECUTION_MODES.HEADLESS,
    resumeSession: false,
    mcpServers,
    hooks: null,
    toolPermissions: null,
    ...(ctrlyokeMcpMode ? { ctrlyokeMcpMode } : {}),
  };
}

suite("McpServerNormalizer", () => {
  test("suppresses only the ctrlyoke server when it is in skill mode", async () => {
    let plannedServerPath: string | undefined = "not-called";
    let plannedServers: McpServerConfig[] | undefined;
    await CliProviderUtils.planMcpConfigBlock(
      {
        promptIndex: 0,
        allPrompts: [],
        resolvedProperties: createProperties(
          ["ctrlyoke", PLAYWRIGHT_SERVER],
          CTRLYOKE_MCP_MODES.SKILL
        ),
      },
      "/workspace",
      "/extension",
      async (
        serverPath,
        _workspaceRoot,
        _workingFilePath,
        _env,
        userServers
      ) => {
        plannedServerPath = serverPath;
        plannedServers = userServers;
        return { cliArgs: [], mutations: [], diagnostics: [] };
      }
    );

    assert.strictEqual(plannedServerPath, undefined);
    assert.deepStrictEqual(plannedServers, [PLAYWRIGHT_SERVER]);
  });

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

  test("trusts secret references only from a user-only registry entry", async () => {
    const server: McpServerConfig = {
      id: "registry-secret",
      command: "node",
      env: { TOKEN: "${secret:REGISTRY_TOKEN}" },
    };
    const userEntry: ManagedMcpServer = {
      id: server.id,
      displayName: server.id,
      config: server,
      locations: [
        { targetId: "ctrlyoke", scope: SETTING_SCOPES.USER, path: "user" },
      ],
    };
    const workspaceEntry: ManagedMcpServer = {
      ...userEntry,
      locations: [
        {
          targetId: "ctrlyoke",
          scope: SETTING_SCOPES.WORKSPACE,
          path: "workspace",
        },
      ],
    };

    const userResult = await McpServerNormalizer.applyWithDiagnostics(
      createProperties([server.id]),
      [userEntry]
    );
    const workspaceResult = await McpServerNormalizer.applyWithDiagnostics(
      createProperties([server.id]),
      [workspaceEntry]
    );

    assert.deepStrictEqual(userResult.trustedUserScopeSecretNames, [
      "REGISTRY_TOKEN",
    ]);
    assert.deepStrictEqual(workspaceResult.trustedUserScopeSecretNames, []);
  });

  test("keeps the ctrlyoke sentinel as a string", async () => {
    const normalized = await McpServerNormalizer.apply(
      createProperties(["ctrlyoke"]),
      MANAGED_SERVERS
    );
    assert.deepStrictEqual(normalized.mcpServers, ["ctrlyoke"]);
  });

  test("merges an inline MCP reference when no MCP property is configured", async () => {
    const normalized = await McpServerNormalizer.apply(
      createProperties([]),
      MANAGED_SERVERS,
      "/mcp:playwright"
    );
    assert.deepStrictEqual(normalized.mcpServers, [PLAYWRIGHT_SERVER]);
  });

  test("merges inline MCP references with the ctrlyoke sentinel without duplication", async () => {
    const normalized = await McpServerNormalizer.apply(
      createProperties(["ctrlyoke"]),
      MANAGED_SERVERS,
      "only use /mcp:ctrlyoke if needed, and /mcp:playwright for UI tests"
    );
    assert.deepStrictEqual(normalized.mcpServers, [
      "ctrlyoke",
      PLAYWRIGHT_SERVER,
    ]);
  });

  test("lets a known inline MCP reference override an explicit null", async () => {
    const normalized = await McpServerNormalizer.apply(
      createProperties(null),
      MANAGED_SERVERS,
      "/mcp:playwright"
    );
    assert.deepStrictEqual(normalized.mcpServers, [PLAYWRIGHT_SERVER]);
  });

  test("drops unknown IDs without throwing", async () => {
    const result = await McpServerNormalizer.applyWithDiagnostics(
      createProperties(["missing"]),
      MANAGED_SERVERS
    );
    assert.deepStrictEqual(result.properties.mcpServers, []);
    assert.strictEqual(result.diagnostics.length, 1);
    assert.strictEqual(
      result.diagnostics[0].code,
      PROMPT_DIAGNOSTIC_CODES.UNKNOWN_MCP_REFERENCE
    );
    assert.match(result.diagnostics[0].message, /listed in mcpServers/u);
  });

  test("keeps an unknown inline MCP reference and emits a diagnostic", async () => {
    const result = await McpServerNormalizer.applyWithDiagnostics(
      createProperties(null),
      MANAGED_SERVERS,
      "/mcp:unknown"
    );
    assert.strictEqual(result.properties.mcpServers, null);
    assert.strictEqual(result.diagnostics.length, 1);
    assert.strictEqual(
      result.diagnostics[0].code,
      PROMPT_DIAGNOSTIC_CODES.UNKNOWN_MCP_REFERENCE
    );
  });

  test("preserves an explicit null MCP override", async () => {
    const properties = createProperties(null);
    assert.strictEqual(
      await McpServerNormalizer.apply(properties, MANAGED_SERVERS),
      properties
    );
  });
});
