import * as assert from "assert";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";

import type { ConfigBackend } from "../../config/CtrlYokeConfigService";
import {
  bootstrapCliWorkspace,
  type CliWorkspaceBootstrapDependencies,
  type CliWorkspaceConfigService,
} from "../../cli/CliWorkspaceBootstrap";
import { RUN_HISTORY_LOCATIONS } from "../../types/DashboardConstants";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";

class FakeConfigService implements CliWorkspaceConfigService {
  overlay?: PartialCtrlYokeSettings;
  storageReads = 0;

  setUserBackend(_backend: ConfigBackend): void {}

  setWorkspaceBackend(_backend: ConfigBackend): void {}

  setCliOverlay(overlay: PartialCtrlYokeSettings): void {
    this.overlay = overlay;
  }

  get(_key: "storage") {
    this.storageReads += 1;
    return { runHistoryLocation: RUN_HISTORY_LOCATIONS.WORKSPACE };
  }
}

suite("CLI workspace bootstrap", () => {
  let config: FakeConfigService;
  let initialized: boolean;
  let initializedLocation: string | undefined;
  let registryInitialization:
    | { workspaceRoot: string; gitToplevel: string | undefined }
    | undefined;

  setup(() => {
    config = new FakeConfigService();
    initialized = false;
    initializedLocation = undefined;
    registryInitialization = undefined;
  });

  teardown(() => {
    initialized = false;
    initializedLocation = undefined;
    registryInitialization = undefined;
  });

  function dependencies(): CliWorkspaceBootstrapDependencies {
    const backend = {} as ConfigBackend;
    return {
      configService: config,
      initializeCliLog: () => {},
      createUserConfigBackend: () => backend,
      createWorkspaceConfigBackend: () => backend,
      isRunHistoryLocationInitialized: () => initialized,
      initializeRunHistoryLocation: (location) => {
        initialized = true;
        initializedLocation = location;
      },
      repoToplevel: async () => "repo-root",
      createProjectStateRegistry: () => ({
        initialize: async (workspaceRoot, gitToplevel) => {
          registryInitialization = { workspaceRoot, gitToplevel };
          return { projectRoot: workspaceRoot };
        },
      }),
    };
  }

  test("passes the CLI overlay to the config service", async () => {
    const overlay: PartialCtrlYokeSettings = {
      runs: { historySearchCacheMb: 0 },
    };

    const result = await bootstrapCliWorkspace(
      { cwd: "workspace" },
      overlay,
      dependencies()
    );

    assert.strictEqual(result.workspaceRoot, path.resolve("workspace"));
    assert.strictEqual(config.overlay, overlay);
    assert.strictEqual(initializedLocation, RUN_HISTORY_LOCATIONS.WORKSPACE);
    assert.deepStrictEqual(registryInitialization, {
      workspaceRoot: path.resolve("workspace"),
      gitToplevel: "repo-root",
    });
  });

  test("does not read or initialize run-history location when already initialized", async () => {
    initialized = true;

    await bootstrapCliWorkspace({ cwd: "workspace" }, {}, dependencies());

    assert.strictEqual(config.storageReads, 0);
    assert.strictEqual(initializedLocation, undefined);
    assert.ok(registryInitialization);
  });
});
