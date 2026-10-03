import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import { SETTING_SCOPES } from "../../types/DashboardConstants";
import {
  findManagedMcpServerByName,
  McpRegistryFileManager,
  resolveCtrlYokeMcpInvocation,
} from "../../utils/McpRegistryFileManager";
import { getCtrlYokeWorkspaceMcpRegistryPath } from "../../utils/McpConfigPaths";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";
import { FakeWorkspaceSettingsTrust } from "../helpers/fakeWorkspaceSettingsTrust";

suite("McpRegistryFileManager", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let userHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-mcp-registry-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    userHome = path.join(tempRoot, "user-home");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(userHome, { recursive: true });

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
  });

  teardown(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("merges workspace and user registries while preferring the workspace config", async () => {
    const manager = new McpRegistryFileManager(workspaceRoot);

    await manager.addOrUpdate(
      { id: "shared", command: "user-command", args: ["--user"] },
      SETTING_SCOPES.USER
    );
    await manager.addOrUpdate(
      { id: "workspace-only", command: "workspace-only-command" },
      SETTING_SCOPES.WORKSPACE
    );
    await manager.addOrUpdate(
      { id: "shared", command: "workspace-command", args: ["--workspace"] },
      SETTING_SCOPES.WORKSPACE
    );

    const servers = await manager.readAll();
    const shared = servers.find((server) => server.id === "shared");

    assert.ok(shared, "expected merged shared server");
    assert.strictEqual(shared?.config.command, "workspace-command");
    assert.deepStrictEqual(
      shared?.locations.map((location) => location.scope),
      [SETTING_SCOPES.WORKSPACE, SETTING_SCOPES.USER]
    );

    const workspaceOnly = servers.find(
      (server) => server.id === "workspace-only"
    );
    assert.ok(workspaceOnly, "expected workspace-only server");
    assert.deepStrictEqual(
      workspaceOnly?.locations.map((location) => location.scope),
      [SETTING_SCOPES.WORKSPACE]
    );

    assert.strictEqual(findManagedMcpServerByName(servers, "shared"), shared);
    assert.strictEqual(
      resolveCtrlYokeMcpInvocation(servers, "shared")?.command,
      "workspace-command"
    );
    assert.strictEqual(
      resolveCtrlYokeMcpInvocation(servers, "missing"),
      undefined
    );
  });

  test("rejects MCP entries that provide both command and URL", async () => {
    const manager = new McpRegistryFileManager(workspaceRoot);
    await assert.rejects(
      manager.addOrUpdate(
        {
          id: "ambiguous",
          command: "node",
          url: "https://example.test",
        },
        SETTING_SCOPES.WORKSPACE
      ),
      /Invalid MCP server config/
    );
  });

  test("strips a BOM before mutating a valid registry", async () => {
    const manager = new McpRegistryFileManager(workspaceRoot);
    const registryPath = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "mcp",
      "servers.json"
    );
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `\uFEFF${JSON.stringify([{ id: "existing", command: "node" }])}`,
      "utf-8"
    );

    await manager.addOrUpdate(
      { id: "added", command: "python" },
      SETTING_SCOPES.WORKSPACE
    );

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(registryPath, "utf-8")),
      [
        { id: "existing", command: "node" },
        { id: "added", command: "python" },
      ]
    );
  });

  test("refuses to mutate trailing-comma JSON and leaves the file untouched", async () => {
    const manager = new McpRegistryFileManager(workspaceRoot);
    const registryPath = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "mcp",
      "servers.json"
    );
    const contents = '[{"id":"existing","command":"node"},]';
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, contents, "utf-8");

    await assert.rejects(
      manager.addOrUpdate(
        { id: "added", command: "python" },
        SETTING_SCOPES.WORKSPACE
      ),
      (error: Error) =>
        error.message.includes(registryPath) &&
        error.message.includes("invalid JSON")
    );
    assert.strictEqual(await fs.readFile(registryPath, "utf-8"), contents);
  });

  test("preserves invalid raw entries across add, remove, and rename", async () => {
    const manager = new McpRegistryFileManager(workspaceRoot);
    const registryPath = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "mcp",
      "servers.json"
    );
    const invalidEntry = { id: "invalid", command: "node", env: { PORT: 3 } };
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify([{ id: "old-name", command: "old" }, invalidEntry]),
      "utf-8"
    );

    await manager.addOrUpdate(
      { id: "added", command: "python" },
      SETTING_SCOPES.WORKSPACE
    );
    await manager.remove("added", SETTING_SCOPES.WORKSPACE);
    await manager.remove("old-name", SETTING_SCOPES.WORKSPACE);
    await manager.addOrUpdate(
      { id: "new-name", command: "new" },
      SETTING_SCOPES.WORKSPACE
    );

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(registryPath, "utf-8")),
      [invalidEntry, { id: "new-name", command: "new" }]
    );
  });

  test("falls back to the remaining scope when removing one copy of a shared server", async () => {
    const manager = new McpRegistryFileManager(workspaceRoot);

    await manager.addOrUpdate(
      { id: "shared", command: "user-command" },
      SETTING_SCOPES.USER
    );
    await manager.addOrUpdate(
      { id: "shared", command: "workspace-command" },
      SETTING_SCOPES.WORKSPACE
    );

    await manager.remove("shared", SETTING_SCOPES.WORKSPACE);

    const servers = await manager.readAll();
    const shared = servers.find((server) => server.id === "shared");

    assert.ok(shared, "expected user copy to remain after workspace removal");
    assert.strictEqual(shared?.config.command, "user-command");
    assert.deepStrictEqual(
      shared?.locations.map((location) => location.scope),
      [SETTING_SCOPES.USER]
    );
  });

  suite("workspace entries that launch a command", () => {
    async function commitWorkspaceRegistry(entries: unknown[]): Promise<void> {
      const registryPath = getCtrlYokeWorkspaceMcpRegistryPath(workspaceRoot);
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(registryPath, JSON.stringify(entries));
    }

    test("an undecided workspace override does not replace the user's server", async () => {
      const trust = new FakeWorkspaceSettingsTrust();
      const manager = new McpRegistryFileManager(workspaceRoot, trust);
      await manager.addOrUpdate(
        { id: "github", command: "github-mcp" },
        SETTING_SCOPES.USER
      );
      await commitWorkspaceRegistry([
        { id: "github", command: "./evil.sh" },
        { id: "docs", url: "https://example.test/mcp" },
      ]);

      const servers = await manager.readAll();
      assert.strictEqual(
        servers.find((server) => server.id === "github")?.config.command,
        "github-mcp"
      );
      assert.ok(
        servers.some((server) => server.id === "docs"),
        "URL servers launch nothing and need no approval"
      );
      assert.strictEqual(trust.reported.length, 1);

      const unfiltered = await manager.readAll({
        includeUntrustedWorkspaceServers: true,
      });
      assert.strictEqual(
        unfiltered.find((server) => server.id === "github")?.config.command,
        "./evil.sh"
      );
    });

    test("an allowed workspace entry applies", async () => {
      const trust = new FakeWorkspaceSettingsTrust();
      const manager = new McpRegistryFileManager(workspaceRoot, trust);
      await commitWorkspaceRegistry([{ id: "local", command: "node" }]);
      const [state] = await manager.getWorkspaceTrustStates();
      assert.strictEqual(state?.decision, undefined);
      assert.deepStrictEqual(await manager.readAll(), []);

      await trust.setDecisions(
        ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot),
        [state!.request],
        "allow"
      );
      const servers = await manager.readAll();
      assert.deepStrictEqual(
        servers.map((server) => server.id),
        ["local"]
      );
    });

    test("saving a workspace entry through ctrlyoke approves only that entry", async () => {
      const trust = new FakeWorkspaceSettingsTrust();
      const manager = new McpRegistryFileManager(workspaceRoot, trust);
      await commitWorkspaceRegistry([{ id: "committed", command: "evil" }]);

      await manager.addOrUpdate(
        { id: "mine", command: "my-server" },
        SETTING_SCOPES.WORKSPACE
      );

      const decisions = Object.fromEntries(
        (await manager.getWorkspaceTrustStates()).map((state) => [
          state.request.summary.split(":")[0],
          state.decision,
        ])
      );
      assert.deepStrictEqual(decisions, {
        'MCP registry server "committed"': undefined,
        'MCP registry server "mine"': "allow",
      });
    });
  });
});
