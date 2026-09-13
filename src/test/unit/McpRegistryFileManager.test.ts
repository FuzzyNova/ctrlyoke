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
