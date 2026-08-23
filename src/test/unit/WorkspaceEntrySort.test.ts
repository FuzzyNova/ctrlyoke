import * as assert from "assert";
import { suite, test } from "mocha";
import {
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
  type WorkspaceEntry,
} from "../../types/HostedWorkspaceViewerTypes";
import {
  compareWorkspaceEntries,
  sortWorkspaceEntries,
} from "../../server/WorkspaceEntrySort";

suite("WorkspaceEntrySort", () => {
  const entries: WorkspaceEntry[] = [
    { name: "z-file", path: "z-file", kind: "file", modifiedAt: 20 },
    {
      name: "a-directory",
      path: "a-directory",
      kind: "directory",
      modifiedAt: 10,
    },
    { name: "m-file", path: "m-file", kind: "file", modifiedAt: 10 },
    {
      name: "z-directory",
      path: "z-directory",
      kind: "directory",
      modifiedAt: 20,
    },
    { name: "missing-file", path: "missing-file", kind: "file" },
  ];

  test("supports both name directions while preserving directory grouping", () => {
    assert.deepStrictEqual(
      sortWorkspaceEntries(entries, {
        key: WORKSPACE_ENTRY_SORT_KEYS.NAME,
        direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING,
      }).map((entry) => entry.name),
      ["a-directory", "z-directory", "m-file", "missing-file", "z-file"]
    );
    assert.deepStrictEqual(
      sortWorkspaceEntries(entries, {
        key: WORKSPACE_ENTRY_SORT_KEYS.NAME,
        direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
      }).map((entry) => entry.name),
      ["z-directory", "a-directory", "z-file", "missing-file", "m-file"]
    );
  });

  test("supports both modified-time directions and ascending name ties", () => {
    const newestFirst = sortWorkspaceEntries(entries, {
      key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
      direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
    });
    const oldestFirst = sortWorkspaceEntries(entries, {
      key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
      direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING,
    });

    assert.deepStrictEqual(
      newestFirst.map((entry) => entry.name),
      ["z-directory", "a-directory", "z-file", "m-file", "missing-file"]
    );
    assert.deepStrictEqual(
      oldestFirst.map((entry) => entry.name),
      ["a-directory", "z-directory", "m-file", "z-file", "missing-file"]
    );
    const sameTimestampA: WorkspaceEntry = {
      name: "a-file",
      path: "a-file",
      kind: "file",
      modifiedAt: 10,
    };
    const sameTimestampZ: WorkspaceEntry = {
      name: "z-file",
      path: "z-file",
      kind: "file",
      modifiedAt: 10,
    };
    assert.strictEqual(
      compareWorkspaceEntries(sameTimestampA, sameTimestampZ, {
        key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
        direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
      }),
      -1
    );
  });

  test("puts missing timestamps last in either direction", () => {
    for (const direction of Object.values(WORKSPACE_ENTRY_SORT_DIRECTIONS)) {
      const sorted = sortWorkspaceEntries(entries, {
        key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
        direction,
      });
      assert.strictEqual(sorted.at(-1)?.name, "missing-file");
    }
  });

  test("does not mutate the source array", () => {
    const original = [...entries];
    const sorted = sortWorkspaceEntries(entries, {
      key: WORKSPACE_ENTRY_SORT_KEYS.NAME,
      direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
    });
    assert.deepStrictEqual(entries, original);
    assert.notStrictEqual(sorted, entries);
  });
});
