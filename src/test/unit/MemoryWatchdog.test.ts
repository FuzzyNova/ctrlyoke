import * as assert from "assert";
import { afterEach, beforeEach, suite, test } from "mocha";
import { Log } from "../../utils/Log";
import {
  noteMemoryActivity,
  registerMemoryContext,
} from "../../utils/MemoryDiagnostics";
import {
  HEAP_SNAPSHOT_ENV_VAR,
  heapSnapshotThresholdFromEnv,
  MemoryWatchdog,
} from "../../utils/MemoryWatchdog";

const MB = 1024 * 1024;

function usage(heapUsedMb: number): NodeJS.MemoryUsage {
  return {
    rss: (heapUsedMb + 100) * MB,
    heapTotal: (heapUsedMb + 50) * MB,
    heapUsed: heapUsedMb * MB,
    external: 10 * MB,
    arrayBuffers: 0,
  };
}

suite("MemoryWatchdog", () => {
  const originalInfo = Log.info;
  const originalWarn = Log.warn;
  let infos: string[];
  let warns: string[];

  beforeEach(() => {
    infos = [];
    warns = [];
    Log.info = (message: string) => {
      infos.push(message);
    };
    Log.warn = (message: string) => {
      warns.push(message);
    };
  });

  afterEach(() => {
    Log.info = originalInfo;
    Log.warn = originalWarn;
  });

  function watchdog(
    heapMb: { value: number },
    clock: { value: number },
    snapshots: string[],
    getSnapshotDirectory: () => string | undefined = () => "C:/logs"
  ): MemoryWatchdog {
    return new MemoryWatchdog({
      getSnapshotDirectory,
      logDeltaBytes: 50 * MB,
      snapshotThresholdBytes: 1024 * MB,
      memoryUsage: () => usage(heapMb.value),
      now: () => clock.value,
      writeHeapSnapshot: (filePath) => {
        snapshots.push(filePath);
        return filePath;
      },
    });
  }

  test("logs a baseline, then only jumps, naming the activity in between", () => {
    const heap = { value: 300 };
    const clock = { value: Date.now() };
    const unregister = registerMemoryContext("hosted", () => ({
      maxSocketQueuedMB: 42,
    }));
    try {
      const dog = watchdog(heap, clock, []);
      dog.sample();
      assert.strictEqual(infos.length, 1);
      assert.match(infos[0], /heapUsed=300MB \(baseline/);

      heap.value = 320;
      clock.value += 15_000;
      dog.sample();
      assert.strictEqual(infos.length, 1, "a 20MB move is not logged");

      clock.value += 1;
      noteMemoryActivity("hosted send RUN_VIEW_LOADED 40MB client=phone");
      heap.value = 900;
      clock.value += 15_000;
      dog.sample();
      assert.strictEqual(infos.length, 2);
      assert.match(infos[1], /heapUsed=900MB \(\+600MB since/);
      assert.match(infos[1], /hosted\.maxSocketQueuedMB=42/);
      assert.match(infos[1], /activity: .*RUN_VIEW_LOADED 40MB client=phone/);
    } finally {
      unregister();
    }
  });

  test("writes one heap snapshot when the threshold is first crossed", () => {
    const heap = { value: 1100 };
    const clock = { value: Date.now() };
    const snapshots: string[] = [];
    const dog = watchdog(heap, clock, snapshots);

    dog.sample();
    heap.value = 1500;
    clock.value += 15_000;
    dog.sample();

    assert.strictEqual(snapshots.length, 1);
    assert.match(snapshots[0], /ctrlyoke-heap-.*\.heapsnapshot$/);
    assert.ok(warns.some((message) => /heap snapshot written/.test(message)));
  });

  test("skips the snapshot while no session log directory exists", () => {
    const heap = { value: 1500 };
    const snapshots: string[] = [];
    const dog = watchdog(
      heap,
      { value: Date.now() },
      snapshots,
      () => undefined
    );

    dog.sample();
    assert.deepStrictEqual(snapshots, []);
  });

  test("never snapshots without a threshold", () => {
    const snapshots: string[] = [];
    const dog = new MemoryWatchdog({
      getSnapshotDirectory: () => "C:/logs",
      memoryUsage: () => usage(3000),
      writeHeapSnapshot: (filePath) => {
        snapshots.push(filePath);
        return filePath;
      },
    });

    dog.sample();
    assert.deepStrictEqual(snapshots, []);
  });

  test("reads the opt-in snapshot threshold from the environment", () => {
    assert.strictEqual(heapSnapshotThresholdFromEnv({}), undefined);
    assert.strictEqual(
      heapSnapshotThresholdFromEnv({ [HEAP_SNAPSHOT_ENV_VAR]: "abc" }),
      undefined
    );
    assert.strictEqual(
      heapSnapshotThresholdFromEnv({ [HEAP_SNAPSHOT_ENV_VAR]: "0" }),
      undefined
    );
    assert.strictEqual(
      heapSnapshotThresholdFromEnv({ [HEAP_SNAPSHOT_ENV_VAR]: "1536" }),
      1536 * MB
    );
  });
});
