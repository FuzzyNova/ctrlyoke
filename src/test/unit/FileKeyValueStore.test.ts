import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileKeyValueStore } from "../../platform/FileKeyValueStore";
import {
  initializeRunHistoryLocation,
  resetRunHistoryLocationForTests,
} from "../../utils/RunHistoryStoragePolicy";
import { projectStateRoot } from "../../utils/ProjectStatePaths";
import { RUN_HISTORY_LOCATIONS } from "../../types/DashboardConstants";

suite("FileKeyValueStore", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let previousHome: string | undefined;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-host-state-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceRoot);
    previousHome = process.env.CTRLYOKE_HOME;
    process.env.CTRLYOKE_HOME = path.join(tempRoot, "state-home");
    resetRunHistoryLocationForTests();
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
  });

  teardown(async () => {
    // Restore the suite-wide baseline from src/test/suite/index.ts; leaving the
    // location uninitialized breaks later files that share this shard.
    resetRunHistoryLocationForTests();
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
    if (previousHome === undefined) delete process.env.CTRLYOKE_HOME;
    else process.env.CTRLYOKE_HOME = previousHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("persists JSON in project state and removes undefined values", async () => {
    const store = new FileKeyValueStore(workspaceRoot);
    assert.strictEqual(store.get("loaded"), undefined);
    await store.update("loaded", ["first.yaml"]);
    await store.update("browse", "src");
    assert.deepStrictEqual(new FileKeyValueStore(workspaceRoot).get("loaded"), [
      "first.yaml",
    ]);

    await store.update("browse", undefined);
    const persistedPath = path.join(
      projectStateRoot(workspaceRoot, RUN_HISTORY_LOCATIONS.USER),
      "host-state.json"
    );
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(persistedPath, "utf8")),
      {
        loaded: ["first.yaml"],
      }
    );
  });

  test("serializes concurrent updates without dropping earlier keys", async () => {
    const store = new FileKeyValueStore(workspaceRoot);
    await Promise.all([
      store.update("one", 1),
      store.update("two", 2),
      store.update("three", 3),
    ]);
    assert.deepStrictEqual(new FileKeyValueStore(workspaceRoot).get("one"), 1);
    assert.deepStrictEqual(new FileKeyValueStore(workspaceRoot).get("two"), 2);
    assert.deepStrictEqual(
      new FileKeyValueStore(workspaceRoot).get("three"),
      3
    );
  });
});
