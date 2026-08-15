import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { RUN_HISTORY_LOCATIONS } from "../../types/DashboardConstants";
import {
  initializeRunHistoryLocation,
  resetRunHistoryLocationForTests,
} from "../../utils/RunHistoryStoragePolicy";
import {
  ctrlyokeStateHome,
  projectStateRoot,
} from "../../utils/ProjectStatePaths";
import {
  lifetimeStatsPath,
  observedUsagePath,
  providerSnapshotsPath,
} from "../../utils/UsagePaths";

suite("UsagePaths", () => {
  const stateRoot = path.join(os.tmpdir(), "ctrlyoke-usage-paths");

  setup(() => resetRunHistoryLocationForTests());
  teardown(() => {
    resetRunHistoryLocationForTests();
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
  });

  test("keeps lineage usage files beside the selected runs root", () => {
    for (const location of [
      RUN_HISTORY_LOCATIONS.USER,
      RUN_HISTORY_LOCATIONS.WORKSPACE,
    ] as const) {
      resetRunHistoryLocationForTests();
      initializeRunHistoryLocation(location);
      const usageRoot = path.join(
        projectStateRoot(stateRoot, location),
        ".usage"
      );

      assert.strictEqual(
        lifetimeStatsPath(stateRoot),
        path.join(usageRoot, "lifetime-stats.json")
      );
      assert.strictEqual(
        observedUsagePath(stateRoot),
        path.join(usageRoot, "observed-usage.json")
      );
    }
  });

  test("stores provider snapshots in the account-scoped state home", () => {
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
    assert.strictEqual(
      providerSnapshotsPath(),
      path.join(ctrlyokeStateHome(), "usage", "provider-snapshots.json")
    );
  });
});
