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

    assert.deepStrictEqual(JSON.parse(await fs.readFile(registryPath, "utf-8")), [
      { id: "existing", command: "node" },
      { id: "added", command: "python" },
    ]);
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
      JSON.stringify([
        { id: "old-name", command: "old" },
        invalidEntry,
      ]),
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

    assert.deepStrictEqual(JSON.parse(await fs.readFile(registryPath, "utf-8")), [
      invalidEntry,
      { id: "new-name", command: "new" },
    ]);
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
});
