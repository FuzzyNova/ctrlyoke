import * as assert from "assert";
import * as path from "path";
import { PERSISTENT_VALUE_INSTALL_RESULT_KINDS } from "../../types/DashboardConstants";
import {
  ProviderStatuslineRegistration,
  type ProviderStatuslineManager,
} from "../../core/harness/shared/ProviderStatuslineRegistration";
import { CliNotificationMonitor } from "../../core/harness/shared/CliNotificationMonitor";
import type { StatuslineInstallResult } from "../../core/harness/shared/StatuslineManager";

suite("ProviderStatuslineRegistration", () => {
  const workspaceRoot = path.join("tmp", "workspace");
  const extensionPath = path.join("tmp", "extension");
  const resolvedScriptPath = path.join(extensionPath, "statusline.js");

  class TestStatuslineManager implements ProviderStatuslineManager {
    scriptPath: string | undefined = resolvedScriptPath;
    installResult: StatuslineInstallResult = {
      kind: PERSISTENT_VALUE_INSTALL_RESULT_KINDS.WRITTEN,
      captured: false,
    };
    installError: Error | undefined;
    installCalls: Array<{ workspaceRoot: string; command: string }> = [];

    async resolveScriptPath(): Promise<string | undefined> {
      return this.scriptPath;
    }

    async install(
      root: string,
      command: string
    ): Promise<StatuslineInstallResult> {
      this.installCalls.push({ workspaceRoot: root, command });
      if (this.installError) throw this.installError;
      return this.installResult;
    }
  }

  function createRegistration(manager = new TestStatuslineManager()) {
    return {
      manager,
      registration: new ProviderStatuslineRegistration({
        manager,
        logPrefix: "TestProvider",
        harnessLabel: "Test",
        snapshotPrefix: "test",
        tokenEnvironmentVariable: "CTRLYOKE_TEST_STATUSLINE_TOKEN",
        directoryEnvironmentVariable: "CTRLYOKE_TEST_STATUSLINE_DIR",
      }),
    };
  }

  test("missing script is a no-op and leaves statusline disabled", async () => {
    const manager = new TestStatuslineManager();
    manager.scriptPath = undefined;
    const { registration } = createRegistration(manager);
    registration.reset("token");

    assert.deepStrictEqual(
      await registration.register(extensionPath, workspaceRoot),
      { kind: PERSISTENT_VALUE_INSTALL_RESULT_KINDS.NO_OP, captured: false }
    );
    assert.strictEqual(registration.enabled, false);
    assert.deepStrictEqual(registration.buildSpawnEnv(), {});
  });

  test("written install enables statusline and builds configured env and path", async () => {
    const { manager, registration } = createRegistration();
    registration.reset("token");

    assert.deepStrictEqual(
      await registration.register(extensionPath, workspaceRoot),
      { kind: PERSISTENT_VALUE_INSTALL_RESULT_KINDS.WRITTEN, captured: false }
    );
    const directory = path.join(workspaceRoot, ".ctrlyoke", "temp");
    const snapshotPath = path.join(directory, "test-statusline-token.json");
    assert.strictEqual(registration.enabled, true);
    assert.deepStrictEqual([...registration.snapshotPaths], [snapshotPath]);
    assert.strictEqual(registration.snapshotPath, snapshotPath);
    assert.deepStrictEqual(registration.buildSpawnEnv(), {
      CTRLYOKE_TEST_STATUSLINE_TOKEN: "token",
      CTRLYOKE_TEST_STATUSLINE_DIR: directory,
      CTRLYOKE_STATUSLINE_WORKSPACE_ROOT: workspaceRoot,
    });
    assert.deepStrictEqual(manager.installCalls, [
      {
        workspaceRoot,
        command: CliNotificationMonitor.buildNodeCommand(resolvedScriptPath, [
          "",
        ]).trim(),
      },
    ]);
  });

  test("declined install stays disabled and emits no statusline environment", async () => {
    const manager = new TestStatuslineManager();
    manager.installResult = {
      kind: PERSISTENT_VALUE_INSTALL_RESULT_KINDS.DECLINED,
      captured: false,
    };
    const { registration } = createRegistration(manager);
    registration.reset("token");

    assert.strictEqual(
      (await registration.register(extensionPath, workspaceRoot)).kind,
      PERSISTENT_VALUE_INSTALL_RESULT_KINDS.DECLINED
    );
    assert.strictEqual(registration.enabled, false);
    assert.strictEqual(registration.snapshotPath, undefined);
    assert.deepStrictEqual(registration.buildSpawnEnv(), {});
  });

  test("install failures are a no-op", async () => {
    const manager = new TestStatuslineManager();
    manager.installError = new Error("install failed");
    const { registration } = createRegistration(manager);
    registration.reset("token");

    assert.deepStrictEqual(
      await registration.register(extensionPath, workspaceRoot),
      { kind: PERSISTENT_VALUE_INSTALL_RESULT_KINDS.NO_OP, captured: false }
    );
    assert.strictEqual(registration.enabled, false);
    assert.deepStrictEqual(registration.buildSpawnEnv(), {});
  });

  test("reset clears prompt state and install result while retaining cleanup paths", async () => {
    const { registration } = createRegistration();
    registration.reset("first");
    await registration.register(extensionPath, workspaceRoot);
    const snapshotPaths = registration.snapshotPaths;
    registration.reset("second");

    assert.strictEqual(registration.token, "second");
    assert.strictEqual(registration.directory, undefined);
    assert.strictEqual(registration.workspaceRoot, undefined);
    assert.strictEqual(registration.snapshotPath, undefined);
    assert.strictEqual(registration.enabled, false);
    assert.deepStrictEqual(registration.buildSpawnEnv(), {});
    assert.deepStrictEqual(registration.snapshotPaths, snapshotPaths);
    assert.strictEqual(registration.consumeInstallResult(), undefined);
  });

  test("consumeInstallResult returns the result only once", async () => {
    const { registration } = createRegistration();
    registration.reset("token");
    const result = await registration.register(extensionPath, workspaceRoot);

    assert.deepStrictEqual(registration.consumeInstallResult(), result);
    assert.strictEqual(registration.consumeInstallResult(), undefined);
  });
});
