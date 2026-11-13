import * as assert from "assert";
import { suite, test } from "mocha";
import type {
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../../types/CtrlYokeTypes";
import { WorkflowScheduler } from "../../core/orchestration/WorkflowScheduler";

class FakeTimers {
  private nextId = 0;
  readonly entries = new Map<number, { callback: () => void; delay: number }>();
  setTimeout(
    callback: () => void,
    delay: number
  ): ReturnType<typeof setTimeout> {
    const id = ++this.nextId;
    this.entries.set(id, { callback, delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.entries.delete(timer as unknown as number);
  }
  async fireNext(): Promise<void> {
    const first = this.entries.entries().next().value as
      [number, { callback: () => void; delay: number }] | undefined;
    if (!first) throw new Error("No timer is armed");
    this.entries.delete(first[0]);
    first[1].callback();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }
}

suite("WorkflowScheduler", () => {
  const key = "sample-workflow" as WorkflowKey;
  const occurrence = new Date(2030, 0, 1, 9, 0, 0).getTime();
  function makeDescriptor(
    overrides: Partial<WorkflowLineageDescriptor> = {}
  ): WorkflowLineageDescriptor {
    return {
      schemaVersion: 1,
      workflowKey: key,
      workflowName: "Sample",
      isFavorite: false,
      nextRunId: 1,
      createdAt: 0,
      lastModifiedAt: 0,
      revision: 7,
      schedule: {
        enabled: true,
        hostId: "test-host",
        trigger: {
          at: new Date(occurrence).toLocaleString("sv-SE").replace(" ", "T"),
        },
      },
      scheduleNextRunAt: occurrence,
      ...overrides,
    };
  }
  function setup(
    overrides: {
      descriptor?: WorkflowLineageDescriptor;
      running?: boolean;
      fire?: () => Promise<void>;
      checkRunning?: () => Promise<boolean>;
      beforeMetadata?: () => Promise<void>;
    } = {}
  ) {
    let descriptor = overrides.descriptor ?? makeDescriptor();
    const timers = new FakeTimers();
    let now = occurrence - 1000;
    let fires = 0;
    const repository = {
      listLineageKeys: async () => [key],
      readDescriptor: async () => descriptor,
      updateDescriptorMetadata: async (
        _root: string,
        _key: WorkflowKey,
        mutate: (
          current: WorkflowLineageDescriptor
        ) => WorkflowLineageDescriptor
      ) => {
        await overrides.beforeMetadata?.();
        descriptor = { ...mutate(descriptor), revision: descriptor.revision };
        return descriptor;
      },
    };
    const scheduler = new WorkflowScheduler({
      lineageRepository: repository as never,
      workspaceRoot: "/workspace",
      now: () => now,
      timers,
      getHostId: () => "test-host",
      isLineageRunning: () =>
        overrides.checkRunning?.() ?? (overrides.running ?? false),
      fire: async () => {
        fires += 1;
        await overrides.fire?.();
      },
    });
    return {
      scheduler,
      timers,
      descriptor: () => descriptor,
      fires: () => fires,
      setDescriptor: (value: WorkflowLineageDescriptor) => {
        descriptor = value;
      },
      setNow: (value: number) => {
        now = value;
      },
    };
  }

  test("arms enabled matching schedule at start and leaves mismatch or disabled schedules inert", async () => {
    const armed = setup();
    await armed.scheduler.start();
    assert.strictEqual(armed.timers.entries.size, 1);
    assert.strictEqual([...armed.timers.entries.values()][0].delay, 1000);
    const wrongHost = setup({
      descriptor: makeDescriptor({
        schedule: { ...makeDescriptor().schedule!, hostId: "other" },
      }),
    });
    await wrongHost.scheduler.start();
    assert.strictEqual(wrongHost.timers.entries.size, 0);
    const disabled = setup({
      descriptor: makeDescriptor({
        schedule: { ...makeDescriptor().schedule!, enabled: false },
      }),
    });
    await disabled.scheduler.start();
    assert.strictEqual(disabled.timers.entries.size, 0);
  });

  test("fires once and updates schedule metadata without changing revision; dispose clears timers", async () => {
    const testCase = setup();
    await testCase.scheduler.start();
    testCase.setNow(occurrence);
    await testCase.timers.fireNext();
    assert.strictEqual(testCase.fires(), 1);
    assert.strictEqual(testCase.descriptor().scheduleLastRunAt, occurrence);
    assert.strictEqual(testCase.descriptor().revision, 7);
    assert.strictEqual(testCase.descriptor().scheduleNextRunAt, undefined);
    // The one-shot is used up, so the lineage stops reading as scheduled.
    assert.strictEqual(testCase.descriptor().schedule, undefined);
    testCase.scheduler.dispose();
    assert.strictEqual(testCase.timers.entries.size, 0);
  });

  test("keeps a recurring schedule after it fires", async () => {
    const missedAt = occurrence - 10_000;
    const testCase = setup({
      descriptor: makeDescriptor({
        schedule: {
          enabled: true,
          hostId: "test-host",
          trigger: { cron: "0 9 * * *" },
        },
        scheduleLastMissedAt: missedAt,
      }),
    });
    await testCase.scheduler.start();
    testCase.setNow(occurrence);
    await testCase.timers.fireNext();
    assert.strictEqual(testCase.fires(), 1);
    assert.ok(testCase.descriptor().schedule);
    assert.ok(testCase.descriptor().scheduleNextRunAt! > occurrence);
    assert.strictEqual(testCase.descriptor().scheduleLastMissedAt, undefined);
  });

  test("keeps a refreshed schedule when a scheduled fire is pending", async () => {
    let resolveFire!: () => void;
    const firePending = new Promise<void>((resolve) => (resolveFire = resolve));
    const original = makeDescriptor({
      schedule: { enabled: true, hostId: "test-host", trigger: { cron: "0 9 * * *" } },
    });
    const testCase = setup({ descriptor: original, fire: () => firePending });
    await testCase.scheduler.start();
    testCase.setNow(occurrence);
    await testCase.timers.fireNext();

    const newAt = occurrence + 8 * 60 * 60 * 1000;
    const newSchedule = {
      enabled: true,
      hostId: "test-host",
      trigger: { at: new Date(newAt).toLocaleString("sv-SE").replace(" ", "T") },
    };
    testCase.setDescriptor(
      makeDescriptor({ schedule: newSchedule, scheduleNextRunAt: newAt })
    );
    await testCase.scheduler.refresh(key);
    resolveFire();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(testCase.descriptor().scheduleNextRunAt, newAt);
    assert.strictEqual(testCase.timers.entries.size, 1);
    assert.strictEqual([...testCase.timers.entries.values()][0].delay, newAt - occurrence);
  });

  test("keeps a refreshed schedule when the overlap check is pending", async () => {
    let resolveCheck!: (running: boolean) => void;
    const checkPending = new Promise<boolean>((resolve) => (resolveCheck = resolve));
    const testCase = setup({
      descriptor: makeDescriptor({
        schedule: { enabled: true, hostId: "test-host", trigger: { cron: "0 9 * * *" } },
      }),
      checkRunning: () => checkPending,
    });
    await testCase.scheduler.start();
    testCase.setNow(occurrence);
    await testCase.timers.fireNext();
    const newAt = occurrence + 8 * 60 * 60 * 1000;
    const newSchedule = {
      enabled: true,
      hostId: "test-host",
      trigger: { at: new Date(newAt).toLocaleString("sv-SE").replace(" ", "T") },
    };
    testCase.setDescriptor(makeDescriptor({ schedule: newSchedule, scheduleNextRunAt: newAt }));
    await testCase.scheduler.refresh(key);
    resolveCheck(true);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    assert.strictEqual(testCase.descriptor().scheduleNextRunAt, newAt);
    assert.strictEqual(testCase.timers.entries.size, 1);
    assert.strictEqual([...testCase.timers.entries.values()][0].delay, newAt - occurrence);
  });

  test("keeps a refreshed schedule when a scheduled fire fails after refresh", async () => {
    let rejectFire!: (error: Error) => void;
    const firePending = new Promise<void>((_resolve, reject) => (rejectFire = reject));
    const testCase = setup({
      descriptor: makeDescriptor({
        schedule: { enabled: true, hostId: "test-host", trigger: { cron: "0 9 * * *" } },
      }),
      fire: () => firePending,
    });
    await testCase.scheduler.start();
    testCase.setNow(occurrence);
    await testCase.timers.fireNext();
    const newAt = occurrence + 8 * 60 * 60 * 1000;
    const newSchedule = {
      enabled: true,
      hostId: "test-host",
      trigger: { at: new Date(newAt).toLocaleString("sv-SE").replace(" ", "T") },
    };
    testCase.setDescriptor(makeDescriptor({ schedule: newSchedule, scheduleNextRunAt: newAt }));
    await testCase.scheduler.refresh(key);
    rejectFire(new Error("fire failed"));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    assert.strictEqual(testCase.descriptor().scheduleNextRunAt, newAt);
    assert.strictEqual(testCase.timers.entries.size, 1);
    assert.strictEqual([...testCase.timers.entries.values()][0].delay, newAt - occurrence);
  });

  test("keeps a refreshed schedule when a late wake metadata write is pending", async () => {
    let releaseMetadata!: () => void;
    const metadataPending = new Promise<void>((resolve) => (releaseMetadata = resolve));
    const testCase = setup({
      beforeMetadata: () => metadataPending,
      descriptor: makeDescriptor({
        schedule: { enabled: true, hostId: "test-host", trigger: { cron: "0 9 * * *" } },
      }),
    });
    await testCase.scheduler.start();
    testCase.setNow(occurrence + 61_000);
    await testCase.timers.fireNext();
    const newAt = occurrence + 8 * 60 * 60 * 1000;
    const newSchedule = {
      enabled: true,
      hostId: "test-host",
      trigger: { at: new Date(newAt).toLocaleString("sv-SE").replace(" ", "T") },
    };
    testCase.setDescriptor(makeDescriptor({ schedule: newSchedule, scheduleNextRunAt: newAt }));
    await testCase.scheduler.refresh(key);
    releaseMetadata();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    assert.strictEqual(testCase.descriptor().scheduleNextRunAt, newAt);
    assert.strictEqual(testCase.timers.entries.size, 1);
    assert.strictEqual([...testCase.timers.entries.values()][0].delay, newAt - (occurrence + 61_000));
  });

  test("refresh re-arms or disarms; overlapping occurrence is skipped", async () => {
    const testCase = setup({ running: true });
    await testCase.scheduler.start();
    await testCase.scheduler.refresh(key);
    assert.strictEqual(testCase.timers.entries.size, 1);
    testCase.setNow(occurrence);
    await testCase.timers.fireNext();
    assert.strictEqual(testCase.fires(), 0);
    testCase.setDescriptor(
      makeDescriptor({
        schedule: { ...makeDescriptor().schedule!, enabled: false },
      })
    );
    await testCase.scheduler.refresh(key);
    assert.strictEqual(testCase.timers.entries.size, 0);
    testCase.scheduler.dispose();
    assert.strictEqual(testCase.timers.entries.size, 0);
  });

  test("chunks a deadline beyond 24 hours", async () => {
    const future = occurrence + 3 * 24 * 60 * 60 * 1000;
    const date = new Date(future).toLocaleString("sv-SE").replace(" ", "T");
    const testCase = setup({
      descriptor: makeDescriptor({
        schedule: { enabled: true, hostId: "test-host", trigger: { at: date } },
        scheduleNextRunAt: future,
      }),
    });
    await testCase.scheduler.start();
    assert.strictEqual(
      [...testCase.timers.entries.values()][0].delay,
      24 * 60 * 60 * 1000
    );
  });

  test("skips a cached occurrence missed while offline", async () => {
    const testCase = setup({
      descriptor: makeDescriptor({
        schedule: {
          enabled: true,
          hostId: "test-host",
          trigger: { cron: "* * * * *" },
        },
        scheduleNextRunAt: occurrence - 10_000,
      }),
    });
    testCase.setNow(occurrence + 1000);
    await testCase.scheduler.start();
    assert.strictEqual(testCase.fires(), 0);
    assert.strictEqual(
      testCase.descriptor().scheduleLastMissedAt,
      occurrence - 10_000
    );
    assert.ok(testCase.descriptor().scheduleNextRunAt! > occurrence + 1000);
  });
});
