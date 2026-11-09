import * as assert from "assert";
import { suite, test } from "mocha";
import { IdleLruSnapshotStore } from "../../server/IdleLruSnapshotStore";

interface Snapshot {
  lastAccessedAt: number;
  value: string;
}

suite("IdleLruSnapshotStore", () => {
  test("creates IDs that do not collide with existing keys", () => {
    const store = new IdleLruSnapshotStore<Snapshot>({
      ttlMs: 100,
      maxCount: 3,
    });
    store.set("existing-id", { lastAccessedAt: 0, value: "existing" });

    assert.notStrictEqual(store.createId(), "existing-id");
  });

  test("expires entries at the idle TTL boundary", () => {
    const store = new IdleLruSnapshotStore<Snapshot>({
      ttlMs: 10,
      maxCount: 3,
    });
    store.set("snapshot", { lastAccessedAt: 5, value: "kept until boundary" });

    assert.strictEqual(store.get("snapshot", 14)?.value, "kept until boundary");
    assert.strictEqual(store.get("snapshot", 24), undefined);
  });

  test("moves hits to the newest end of the LRU order", () => {
    const evicted: string[] = [];
    const store = new IdleLruSnapshotStore<Snapshot>({
      ttlMs: 100,
      maxCount: 2,
      onEvict: (snapshot) => evicted.push(snapshot.value),
    });
    store.set("first", { lastAccessedAt: 0, value: "first" });
    store.set("second", { lastAccessedAt: 0, value: "second" });

    assert.strictEqual(store.get("first", 1)?.value, "first");
    store.set("third", { lastAccessedAt: 1, value: "third" });

    assert.deepStrictEqual(evicted, ["second"]);
    assert.strictEqual(store.get("first", 2)?.value, "first");
    assert.strictEqual(store.get("second", 2), undefined);
  });

  test("calls onEvict for entries removed by expiry and capacity trimming", () => {
    const evicted: string[] = [];
    const store = new IdleLruSnapshotStore<Snapshot>({
      ttlMs: 10,
      maxCount: 1,
      onEvict: (snapshot) => evicted.push(snapshot.value),
    });
    store.set("expired", { lastAccessedAt: 0, value: "expired" });
    assert.strictEqual(store.get("missing", 10), undefined);

    store.set("oldest", { lastAccessedAt: 10, value: "oldest" });
    store.set("newest", { lastAccessedAt: 10, value: "newest" });

    assert.deepStrictEqual(evicted, ["expired", "oldest"]);
    assert.strictEqual(store.get("oldest", 10), undefined);
    assert.strictEqual(store.get("newest", 10)?.value, "newest");
  });
});
