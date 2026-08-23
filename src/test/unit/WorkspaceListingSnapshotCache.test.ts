import * as assert from "assert";
import { suite, test } from "mocha";
import {
  WorkspaceListingSnapshotCache,
  type WorkspaceListingSnapshotInput,
} from "../../server/WorkspaceListingSnapshotCache";

suite("WorkspaceListingSnapshotCache", () => {
  let now = 0;
  let nextId = 0;

  const createCache = (
    options: ConstructorParameters<typeof WorkspaceListingSnapshotCache>[0] = {}
  ) =>
    new WorkspaceListingSnapshotCache({
      now: () => now,
      idFactory: () => `listing-${++nextId}`,
      ...options,
    });

  const snapshotInput = (
    estimatedMetadataBytes?: number
  ): WorkspaceListingSnapshotInput => ({
    resolvedDirectory: "C:/workspace/src",
    rootLabel: "workspace",
    path: "src",
    parentPath: "",
    isGitRepo: true,
    isRootsList: false,
    includeGitIgnored: false,
    order: "name-ascending",
    pageSize: 100,
    entries: [
      { name: "index.ts", path: "src/index.ts", kind: "file", size: 12 },
    ],
    estimatedMetadataBytes,
  });

  setup(() => {
    now = 0;
    nextId = 0;
  });

  test("expires idle snapshots without sleeping", () => {
    const cache = createCache({ ttlMs: 100 });
    const snapshot = cache.create(snapshotInput());

    now = 99;
    assert.ok(cache.get(snapshot.listingId));
    now = 198;
    assert.ok(cache.get(snapshot.listingId));
    now = 299;
    assert.strictEqual(cache.get(snapshot.listingId), undefined);
  });

  test("refreshes the idle TTL and LRU position on successful access", () => {
    const cache = createCache({ ttlMs: 1000, maxCount: 2 });
    const first = cache.create(snapshotInput(1));
    const second = cache.create(snapshotInput(1));

    now = 50;
    assert.ok(cache.get(first.listingId));
    now = 101;
    const third = cache.create(snapshotInput(1));

    assert.ok(
      cache.get(first.listingId),
      "accessed snapshot should be retained"
    );
    assert.strictEqual(
      cache.get(second.listingId),
      undefined,
      "least-recently-used snapshot should be evicted"
    );
    assert.ok(cache.get(third.listingId));
  });

  test("evicts the least-recently-used snapshot at the count limit", () => {
    const cache = createCache({ maxCount: 2 });
    const first = cache.create(snapshotInput(1));
    const second = cache.create(snapshotInput(1));
    assert.ok(cache.get(first.listingId));
    const third = cache.create(snapshotInput(1));

    assert.strictEqual(cache.size, 2);
    assert.ok(cache.get(first.listingId));
    assert.strictEqual(cache.get(second.listingId), undefined);
    assert.ok(cache.get(third.listingId));
  });

  test("evicts older snapshots to meet the soft byte target", () => {
    const cache = createCache({ maxEstimatedMetadataBytes: 10 });
    const first = cache.create(snapshotInput(4));
    const second = cache.create(snapshotInput(4));
    const third = cache.create(snapshotInput(4));

    assert.strictEqual(cache.size, 2);
    assert.strictEqual(cache.get(first.listingId), undefined);
    assert.ok(cache.get(second.listingId));
    assert.ok(cache.get(third.listingId));
    assert.strictEqual(cache.totalEstimatedMetadataBytes, 8);
  });

  test("retains the newest snapshot when it alone exceeds the byte target", () => {
    const cache = createCache({ maxEstimatedMetadataBytes: 10 });
    const older = cache.create(snapshotInput(4));
    const newest = cache.create(snapshotInput(20));

    assert.strictEqual(cache.get(older.listingId), undefined);
    assert.ok(cache.get(newest.listingId));
    assert.strictEqual(cache.size, 1);
    assert.strictEqual(cache.totalEstimatedMetadataBytes, 20);
  });

  test("clear removes snapshots and dispose makes the cache inactive", () => {
    const cache = createCache();
    const snapshot = cache.create(snapshotInput());

    cache.clear();
    assert.strictEqual(cache.size, 0);
    assert.strictEqual(cache.get(snapshot.listingId), undefined);

    cache.create(snapshotInput());
    cache.dispose();
    assert.strictEqual(cache.size, 0);
    assert.strictEqual(cache.totalEstimatedMetadataBytes, 0);
    assert.strictEqual(cache.get("listing-2"), undefined);
    assert.throws(() => cache.create(snapshotInput()), /disposed/);
  });
});
