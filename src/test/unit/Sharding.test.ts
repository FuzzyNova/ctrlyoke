import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createWeigher,
  mergeShardTimings,
  readTimings,
  selectShardFiles,
  shardCoordinate,
  testKey,
  timingsPath,
  writeShardTimings,
} from "../suite/sharding";

/** Weight a file by the number embedded in its name, so cases stay readable. */
function weighByName(file: string): number {
  return Number.parseInt(/(\d+)/.exec(file)?.[1] ?? "0", 10);
}

function loadOf(files: readonly string[]): number {
  return files.reduce((total, file) => total + weighByName(file), 0);
}

suite("selectShardFiles", () => {
  const files = ["a10.js", "b1.js", "c7.js", "d4.js", "e4.js"];

  test("returns every file untouched for a single shard", () => {
    assert.deepStrictEqual(selectShardFiles(files, 0, 1, weighByName), files);
  });

  test("covers every file exactly once across all shards", () => {
    for (const count of [2, 3, 4, 8]) {
      const union: string[] = [];
      for (let index = 0; index < count; index++) {
        union.push(...selectShardFiles(files, index, count, weighByName));
      }
      assert.deepStrictEqual(
        [...union].sort(),
        [...files].sort(),
        `shard count ${count} did not partition the file list`
      );
    }
  });

  test("packs the heaviest files first instead of striping a sorted list", () => {
    // Striping the sorted list gives 10+7=17 against 1+4+4=9. Longest-first
    // reaches 14/12, which is the best a 26-unit list splits into.
    const loads = [0, 1].map((index) =>
      loadOf(selectShardFiles(files, index, 2, weighByName))
    );
    assert.deepStrictEqual(
      [...loads].sort((a, b) => a - b),
      [12, 14]
    );
  });

  // Every weight being equal is the case that matters most: it is what a first
  // run with nothing recorded and same-size files looks like, and picking the
  // first-minimum bucket every time would drop all of them into shard 1.
  test("spreads files evenly when every weight ties", () => {
    const flat = ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js"];
    const counts = [0, 1, 2].map(
      (index) => selectShardFiles(flat, index, 3, () => 0).length
    );
    assert.deepStrictEqual(counts, [2, 2, 2]);
  });

  test("splits deterministically across calls", () => {
    assert.deepStrictEqual(
      selectShardFiles(files, 0, 2, weighByName),
      selectShardFiles(files, 0, 2, weighByName)
    );
  });

  test("hands back an empty slice when there are more shards than files", () => {
    assert.deepStrictEqual(
      selectShardFiles(["only.js"], 3, 4, weighByName),
      []
    );
  });
});

suite("createWeigher", () => {
  const files = ["a.js", "b.js", "c.js", "d.js"];
  const identity = (file: string) => file;

  test("weighs by recorded milliseconds once most files are covered", () => {
    const weigh = createWeigher(
      files,
      { "a.js": 900, "b.js": 100, "c.js": 500 },
      identity
    );
    assert.strictEqual(weigh("a.js"), 900);
    assert.strictEqual(weigh("b.js"), 100);
  });

  // A file the record misses must not look free, or a newly added slow test
  // lands on a shard that is already full.
  test("weighs an unrecorded file at the median of the recorded ones", () => {
    const weigh = createWeigher(
      files,
      { "a.js": 900, "b.js": 100, "c.js": 500 },
      identity
    );
    assert.strictEqual(weigh("d.js"), 500);
  });

  // Milliseconds and bytes are not comparable, so a sparse record has to be
  // abandoned wholesale rather than mixed with file sizes.
  test("falls back to file size when the record covers too little", () => {
    const weigh = createWeigher(files, { "a.js": 900 }, identity);
    // Nothing on disk at these paths, and a missing file must not throw.
    assert.strictEqual(weigh("a.js"), 0);
    assert.strictEqual(weigh("d.js"), 0);
  });
});

suite("test timing records", () => {
  let root = "";

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-timings-"));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("keys a file relative to the test root with forward slashes", () => {
    const testsRoot = path.join(root, "out", "test");
    assert.strictEqual(
      testKey(testsRoot, path.join(testsRoot, "unit", "Thing.test.js")),
      "unit/Thing.test.js"
    );
  });

  test("reads back what a shard wrote", () => {
    writeShardTimings(root, 2, { "unit/A.test.js": 120 });
    const merged = mergeShardTimings(root, 3);
    assert.deepStrictEqual(merged, { "unit/A.test.js": 120 });
    assert.deepStrictEqual(readTimings(timingsPath(root)), merged);
  });

  // A grep-narrowed run times only a handful of files; replacing the record
  // with that would throw away every other file's measurement.
  test("tops up the existing record rather than replacing it", () => {
    writeShardTimings(root, 0, { "unit/A.test.js": 120 });
    mergeShardTimings(root, 1);
    writeShardTimings(root, 0, { "unit/B.test.js": 300 });
    assert.deepStrictEqual(mergeShardTimings(root, 1), {
      "unit/A.test.js": 120,
      "unit/B.test.js": 300,
    });
  });

  test("clears each shard file once merged, so it is not counted twice", () => {
    writeShardTimings(root, 0, { "unit/A.test.js": 120 });
    mergeShardTimings(root, 1);
    writeShardTimings(root, 0, { "unit/A.test.js": 999 });
    mergeShardTimings(root, 1);
    // Only the second value survives; had the first shard file lingered, the
    // merge order would decide and the record would be unstable.
    assert.deepStrictEqual(readTimings(timingsPath(root)), {
      "unit/A.test.js": 999,
    });
  });

  test("treats a missing or corrupt record as no record at all", () => {
    assert.deepStrictEqual(readTimings(path.join(root, "absent.json")), {});
    const broken = path.join(root, "broken.json");
    fs.writeFileSync(broken, "{not json");
    assert.deepStrictEqual(readTimings(broken), {});
  });

  test("drops entries that are not usable durations", () => {
    const mixed = path.join(root, "mixed.json");
    fs.writeFileSync(
      mixed,
      JSON.stringify({ good: 12, negative: -1, text: "nope", nothing: null })
    );
    assert.deepStrictEqual(readTimings(mixed), { good: 12 });
  });
});

suite("shardCoordinate", () => {
  test("falls back for anything that is not a non-negative integer", () => {
    assert.strictEqual(shardCoordinate(undefined, 1), 1);
    assert.strictEqual(shardCoordinate("", 1), 1);
    assert.strictEqual(shardCoordinate("not-a-number", 4), 4);
    assert.strictEqual(shardCoordinate("-2", 1), 1);
  });

  test("reads a supplied coordinate, including zero", () => {
    assert.strictEqual(shardCoordinate("0", 9), 0);
    assert.strictEqual(shardCoordinate("6", 1), 6);
  });
});
