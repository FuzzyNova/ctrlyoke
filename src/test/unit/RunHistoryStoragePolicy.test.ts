import * as assert from "assert";
import { suite, test, setup, teardown } from "mocha";
import {
  getFrozenRunHistoryLocation,
  initializeRunHistoryLocation,
  resetRunHistoryLocationForTests,
} from "../../utils/RunHistoryStoragePolicy";
import { RUN_HISTORY_LOCATIONS } from "../../types/DashboardConstants";

suite("RunHistoryStoragePolicy", () => {
  setup(() => resetRunHistoryLocationForTests());
  teardown(() => {
    resetRunHistoryLocationForTests();
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
  });

  test("requires initialization before reading", () => {
    assert.throws(
      () => getFrozenRunHistoryLocation(),
      /has not been initialized/
    );
  });

  test("freezes the first initialized location", () => {
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);

    assert.strictEqual(
      getFrozenRunHistoryLocation(),
      RUN_HISTORY_LOCATIONS.USER
    );
    assert.throws(
      () => initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.WORKSPACE),
      /already frozen/
    );
    assert.strictEqual(
      getFrozenRunHistoryLocation(),
      RUN_HISTORY_LOCATIONS.USER
    );
  });

  test("can be reset for an isolated test process", () => {
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.WORKSPACE);
    resetRunHistoryLocationForTests();

    assert.throws(
      () => getFrozenRunHistoryLocation(),
      /has not been initialized/
    );
  });
});
