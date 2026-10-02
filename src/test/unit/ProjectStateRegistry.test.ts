import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import {
  ProjectStateRegistry,
  withUserProjectRegistryLock,
} from "../../utils/ProjectStateRegistry";
import {
  getFrozenRunHistoryLocation,
  resetRunHistoryLocationForTests,
  initializeRunHistoryLocation,
} from "../../utils/RunHistoryStoragePolicy";
import { projectStateRoot } from "../../utils/ProjectStatePaths";
import { RUN_HISTORY_LOCATIONS } from "../../types/DashboardConstants";
import {
  CURRENT_SCHEMA_VERSIONS,
  isNewerSchemaError,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";

suite("ProjectStateRegistry", () => {
  let stateRoot: string;
  let originalCtrlyokeHome: string | undefined;

  setup(async () => {
    stateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-registry-state-")
    );
    originalCtrlyokeHome = process.env.CTRLYOKE_HOME;
    resetRunHistoryLocationForTests();
  });

  teardown(async () => {
    if (originalCtrlyokeHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = originalCtrlyokeHome;
    }
    resetRunHistoryLocationForTests();
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
    await fs.rm(stateRoot, { recursive: true, force: true });
  });

  test("creates and updates project.json while preserving createdAt", async () => {
    const registry = new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.USER);
    const first = await registry.initialize(stateRoot, path.dirname(stateRoot));
    const firstMetadata = JSON.parse(
      await fs.readFile(first.metadataPath!, "utf8")
    ) as Record<string, string | number>;

    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await registry.initialize(stateRoot);
    const secondMetadata = JSON.parse(
      await fs.readFile(second.metadataPath!, "utf8")
    ) as Record<string, string | number>;

    assert.strictEqual(secondMetadata.schemaVersion, 1);
    assert.strictEqual(secondMetadata.statePath, path.resolve(stateRoot));
    assert.strictEqual(secondMetadata.gitToplevel, path.dirname(stateRoot));
    assert.strictEqual(secondMetadata.createdAt, firstMetadata.createdAt);
    assert.notStrictEqual(
      secondMetadata.lastOpenedAt,
      firstMetadata.lastOpenedAt
    );
    assert.strictEqual(
      second.projectRoot,
      projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.USER)
    );
  });

  test("supports a state home reached through a symlink or junction", async () => {
    const realHome = path.join(stateRoot, "real-home");
    const linkedHome = path.join(stateRoot, "linked-home");
    await fs.mkdir(realHome);
    await fs.symlink(
      realHome,
      linkedHome,
      process.platform === "win32" ? "junction" : "dir"
    );
    process.env.CTRLYOKE_HOME = linkedHome;

    const registry = new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.USER);
    const result = await registry.initialize(stateRoot);
    const lockedProjectsRoot = await withUserProjectRegistryLock(
      async (projectsRoot) => projectsRoot
    );

    assert.strictEqual(result.projectRoot, projectStateRoot(stateRoot, "user"));
    assert.strictEqual(
      await fs.realpath(lockedProjectsRoot),
      await fs.realpath(path.join(realHome, "projects"))
    );
  });

  test("rejects a newer metadata schema", async () => {
    const registry = new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.USER);
    const projectRoot = projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.USER);
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "project.json"),
      JSON.stringify({
        schemaVersion:
          CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.PROJECT_METADATA] + 1,
        statePath: stateRoot,
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      })
    );

    await assert.rejects(
      () => registry.initialize(stateRoot),
      (error: unknown) =>
        isNewerSchemaError(error) &&
        error.store === PERSISTED_STORES.PROJECT_METADATA
    );
  });

  test("rejects missing metadata in a non-empty project directory", async () => {
    const registry = new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.USER);
    const projectRoot = projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.USER);
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "unexpected.txt"),
      "owned by nobody"
    );

    await assert.rejects(
      () => registry.initialize(stateRoot),
      /non-empty but has no project metadata/
    );
  });

  test("fails on a state-path collision instead of changing the key", async () => {
    const registry = new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.USER);
    const projectRoot = projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.USER);
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "project.json"),
      JSON.stringify({
        schemaVersion: 1,
        statePath: path.join(stateRoot, "different"),
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      })
    );

    await assert.rejects(
      () => registry.initialize(stateRoot),
      /Project state collision/
    );
  });

  test("does nothing in workspace mode", async () => {
    const registry = new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.WORKSPACE);
    const result = await registry.initialize(stateRoot);

    assert.strictEqual(
      result.projectRoot,
      projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.WORKSPACE)
    );
    await assert.rejects(() => fs.stat(result.projectRoot), { code: "ENOENT" });
    await assert.rejects(
      () => fs.stat(path.join(result.projectRoot, "project.json")),
      { code: "ENOENT" }
    );
  });

  test("rejects a symlinked project directory", async function () {
    const registry = new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.USER);
    const projectRoot = projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.USER);
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-registry-outside-")
    );
    try {
      await fs.mkdir(path.dirname(projectRoot), { recursive: true });
      await fs.symlink(
        outside,
        projectRoot,
        process.platform === "win32" ? "junction" : "dir"
      );
      await assert.rejects(
        () => registry.initialize(stateRoot),
        /must not be a symlink/
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("uses the frozen policy value supplied to the registry", async () => {
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
    const registry = new ProjectStateRegistry();
    const result = await registry.initialize(stateRoot);

    assert.strictEqual(
      result.projectRoot,
      projectStateRoot(stateRoot, getFrozenRunHistoryLocation())
    );
  });
});
