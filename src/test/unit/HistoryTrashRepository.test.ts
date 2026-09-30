import * as assert from "assert";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import {
  HistoryTrashRepository,
  LiveLineageDeleteError,
  toHistoryTrashedMessage,
} from "../../core/orchestration/HistoryTrashRepository";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { clearRunSummaryCache } from "../../core/orchestration/RunSummaryCache";
import {
  EXECUTION_STATES,
  HISTORY_TRASH_ENTRY_KINDS,
  MESSAGE_TYPES,
  RUNNER_IDS,
} from "../../types/DashboardConstants";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  CURRENT_SCHEMA_VERSIONS,
  NewerSchemaError,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUESTER = "webview";

let runOrdinal = 0;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

suite("HistoryTrashRepository", () => {
  let workspace: string;
  let lineages: WorkflowLineageRepository;
  let recorder: TimelineRecorder;
  let trash: HistoryTrashRepository;

  async function createLineage(name: string): Promise<WorkflowKey> {
    return (await lineages.createLineage(workspace, name, name)).workflowKey;
  }

  async function addRun(workflowKey: WorkflowKey, runId: number) {
    const startedAt = Date.UTC(2026, 0, 1) + runOrdinal++ * 1000;
    const runRef = WorkflowPaths.formatRunRef(startedAt);
    await recorder.initializeRunAt(
      WorkflowPaths.runDir(workspace, workflowKey, runRef),
      workflowKey,
      runId,
      startedAt,
      EXECUTION_STATES.COMPLETED
    );
    await lineages.updateDescriptor(workspace, workflowKey, (descriptor) => ({
      ...descriptor,
      latestRunRef: runRef,
      nextRunId: Math.max(descriptor.nextRunId, runId + 1),
    }));
    return runRef;
  }

  async function holdRunnerLock(workflowKey: WorkflowKey, runRef: RunRef) {
    await WorkflowLockManager.acquireLock(workspace, workflowKey, {
      schemaVersion: 2,
      workflowKey,
      runRef,
      runner: RUNNER_IDS.VSCODE,
      pid: process.pid,
      ownerToken: WorkflowLockManager.generateOwnerToken(),
      hostInstanceId: "test-host",
      executionInstanceId: "test-execution",
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
  }

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cy-trash-"));
    lineages = new WorkflowLineageRepository();
    recorder = new TimelineRecorder();
    trash = new HistoryTrashRepository(workspace);
  });

  teardown(async () => {
    await new OutputHistoryManager(workspace).flushPendingIndexRefresh();
    clearRunSummaryCache();
    // The runs and trash roots live under the per-project state directory.
    await fs.rm(path.dirname(WorkflowPaths.runsRoot(workspace)), {
      recursive: true,
      force: true,
    });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("keeps the trash beside .runs, not inside it", () => {
    assert.strictEqual(
      path.dirname(trash.root),
      path.dirname(WorkflowPaths.runsRoot(workspace))
    );
    assert.notStrictEqual(trash.root, WorkflowPaths.runsRoot(workspace));
  });

  test("a deleted run can be restored, and the descriptor repaired", async () => {
    const workflowKey = await createLineage("restore-run");
    const older = await addRun(workflowKey, 1);
    const newer = await addRun(workflowKey, 2);
    const manager = new OutputHistoryManager(workspace);

    const batch = trash.begin(HISTORY_TRASH_ENTRY_KINDS.RUN, REQUESTER);
    await manager.deleteRunByRef(workflowKey, newer, batch);
    const entry = await batch.commit();

    assert.ok(entry);
    assert.deepStrictEqual(await manager.getRunsForWorkflow(workflowKey), [
      older,
    ]);
    assert.deepStrictEqual(entry.items[0].runRefs, [newer]);
    assert.deepStrictEqual(entry.items[0].runIds, [2]);
    assert.strictEqual(entry.items[0].wholeLineage, false);
    assert.match(toHistoryTrashedMessage(entry).message, /Run 2 of/);

    // A new run allocated meanwhile must not take the restored run's ID.
    await lineages.updateDescriptor(workspace, workflowKey, (descriptor) => ({
      ...descriptor,
      nextRunId: 1,
    }));
    const result = await trash.restore(entry.id);

    assert.deepStrictEqual(result, {
      restoredLineages: 0,
      restoredRuns: 1,
      conflicts: [],
    });
    assert.deepStrictEqual(await manager.getRunsForWorkflow(workflowKey), [
      newer,
      older,
    ]);
    const descriptor = await lineages.readDescriptor(workspace, workflowKey);
    assert.strictEqual(descriptor.latestRunRef, newer);
    assert.strictEqual(descriptor.nextRunId, 3);
    assert.deepStrictEqual(await trash.list(30), []);
  });

  test("deleteRunByRef without a batch still goes to Recently deleted", async () => {
    const workflowKey = await createLineage("own-entry");
    const runRef = await addRun(workflowKey, 1);

    await new OutputHistoryManager(workspace).deleteRunByRef(
      workflowKey,
      runRef
    );

    const [entry] = await trash.list(30);
    assert.strictEqual(entry.kind, HISTORY_TRASH_ENTRY_KINDS.RUN);
    assert.deepStrictEqual(entry.items[0].runRefs, [runRef]);
  });

  test("a whole workflow round-trips through Recently deleted", async () => {
    const workflowKey = await createLineage("whole-lineage");
    await addRun(workflowKey, 1);
    await addRun(workflowKey, 2);

    const entry = await trash.trashLineage(workflowKey, REQUESTER);

    assert.ok(entry);
    assert.strictEqual(entry.kind, HISTORY_TRASH_ENTRY_KINDS.LINEAGE);
    assert.strictEqual(entry.items[0].wholeLineage, true);
    assert.strictEqual(entry.items[0].workflowName, "whole-lineage");
    assert.ok(entry.bytes > 0);
    assert.strictEqual(
      await exists(WorkflowPaths.lineageDir(workspace, workflowKey)),
      false
    );
    assert.deepStrictEqual(await lineages.listLineageKeys(workspace), []);

    await trash.restore(entry.id);

    assert.deepStrictEqual(await lineages.listLineageKeys(workspace), [
      workflowKey,
    ]);
    assert.strictEqual(
      (
        await new OutputHistoryManager(workspace).getRunsForWorkflow(
          workflowKey
        )
      ).length,
      2
    );
  });

  test("moves a workflow whose run directory is being watched", async () => {
    // VS Code watches the directory of every open workflow's run file, and
    // Windows refuses to rename a directory with a watcher inside it.
    const workflowKey = await createLineage("watched");
    const runRef = await addRun(workflowKey, 1);
    const watcher = fsSync.watch(
      WorkflowPaths.runDir(workspace, workflowKey, runRef)
    );
    try {
      const entry = await trash.trashLineage(workflowKey, REQUESTER);

      assert.ok(entry);
      assert.deepStrictEqual(entry.items[0].runRefs, [runRef]);
      assert.deepStrictEqual(await lineages.listLineageKeys(workspace), []);
    } finally {
      watcher.close();
    }
  });

  test("refuses to delete a workflow with a live runner lock", async () => {
    const workflowKey = await createLineage("live");
    const runRef = await addRun(workflowKey, 1);
    await holdRunnerLock(workflowKey, runRef);

    await assert.rejects(
      () => trash.trashLineage(workflowKey, REQUESTER),
      LiveLineageDeleteError
    );
    assert.ok(await exists(WorkflowPaths.lineageDir(workspace, workflowKey)));
    assert.deepStrictEqual(await trash.list(30), []);
  });

  test("refuses a workflow the caller reports as executing (a paused run holds no lock)", async () => {
    const workflowKey = await createLineage("paused");
    await addRun(workflowKey, 1);

    await assert.rejects(
      () =>
        trash.trashLineage(
          workflowKey,
          REQUESTER,
          (key) => key === workflowKey
        ),
      LiveLineageDeleteError
    );
  });

  test("clear all moves idle workflows into one entry and keeps live ones", async () => {
    const idleA = await createLineage("idle-a");
    await addRun(idleA, 1);
    const idleB = await createLineage("idle-b");
    await addRun(idleB, 1);
    await addRun(idleB, 2);
    const live = await createLineage("live");
    await holdRunnerLock(live, await addRun(live, 1));

    const preview = await trash.previewClearAll();
    assert.strictEqual(preview.lineageCount, 2);
    assert.strictEqual(preview.runCount, 3);
    assert.deepStrictEqual(
      preview.liveLineages.map((lineage) => lineage.workflowKey),
      [live]
    );

    const { entry, skippedLive, failed } =
      await trash.trashAllLineages(REQUESTER);

    assert.ok(entry);
    assert.strictEqual(entry.kind, HISTORY_TRASH_ENTRY_KINDS.ALL);
    assert.deepStrictEqual(
      entry.items.map((item) => item.workflowKey).sort(),
      [idleA, idleB].sort()
    );
    assert.deepStrictEqual(skippedLive, [live]);
    assert.deepStrictEqual(entry.skippedLive, [live]);
    assert.deepStrictEqual(failed, []);
    assert.deepStrictEqual(await lineages.listLineageKeys(workspace), [live]);

    // One Undo brings every workflow back.
    const result = await trash.restore(entry.id);
    assert.strictEqual(result.restoredLineages, 2);
    assert.strictEqual(result.restoredRuns, 3);
    assert.deepStrictEqual(
      (await lineages.listLineageKeys(workspace)).sort(),
      [idleA, idleB, live].sort()
    );
  });

  test("clear all with nothing idle leaves no entry behind", async () => {
    const live = await createLineage("only-live");
    await holdRunnerLock(live, await addRun(live, 1));

    const { entry } = await trash.trashAllLineages(REQUESTER);

    assert.strictEqual(entry, undefined);
    assert.deepStrictEqual(await fs.readdir(trash.root).catch(() => []), []);
  });

  test("a restore whose run slot is taken again keeps that run in the entry", async () => {
    const workflowKey = await createLineage("conflict");
    const runRef = await addRun(workflowKey, 1);
    const batch = trash.begin(HISTORY_TRASH_ENTRY_KINDS.RUN, REQUESTER);
    await new OutputHistoryManager(workspace).deleteRunByRef(
      workflowKey,
      runRef,
      batch
    );
    const entry = await batch.commit();
    assert.ok(entry);
    // Something reoccupies the run's directory before the restore.
    await fs.mkdir(WorkflowPaths.runDir(workspace, workflowKey, runRef), {
      recursive: true,
    });

    const result = await trash.restore(entry.id);

    assert.deepStrictEqual(result.conflicts, [`${workflowKey}/${runRef}`]);
    const [remaining] = await trash.list(30);
    assert.strictEqual(remaining.id, entry.id);
  });

  test("purgeExpired removes entries past the retention window and keeps younger ones", async () => {
    const keep = await createLineage("keep");
    const expire = await createLineage("expire");
    const old = await trash.trashLineage(expire, REQUESTER);
    const recent = await trash.trashLineage(keep, REQUESTER);
    assert.ok(old && recent);

    const removed = await trash.purgeExpired(
      30,
      Math.max(old.deletedAt, recent.deletedAt) + 30 * DAY_MS + 1
    );

    assert.strictEqual(removed, 2);
    assert.deepStrictEqual(await trash.list(30), []);

    const fresh = await trash.trashLineage(
      await createLineage("fresh"),
      REQUESTER
    );
    assert.ok(fresh);
    assert.strictEqual(
      await trash.purgeExpired(30, fresh.deletedAt + DAY_MS),
      0
    );
    assert.strictEqual((await trash.list(30)).length, 1);
  });

  test("finishes a delete that crashed before committing", async () => {
    const workflowKey = await createLineage("crashed");
    await addRun(workflowKey, 1);
    // Simulate a crash between moving the lineage in and committing.
    const pendingDir = WorkflowPaths.pendingTrashEntryDir(
      workspace,
      "2026-01-01T00-00-00-000Z-deadbeef"
    );
    await fs.mkdir(path.join(pendingDir, "payload"), { recursive: true });
    await fs.rename(
      WorkflowPaths.lineageDir(workspace, workflowKey),
      path.join(pendingDir, "payload", workflowKey)
    );
    const longAgo = new Date(Date.now() - DAY_MS);
    await fs.utimes(pendingDir, longAgo, longAgo);

    const [entry] = await trash.list(30);

    assert.ok(entry, "the interrupted delete should be listed");
    assert.strictEqual(entry.items[0].workflowKey, workflowKey);
    assert.strictEqual(entry.items[0].wholeLineage, true);
    await trash.restore(entry.id);
    assert.deepStrictEqual(await lineages.listLineageKeys(workspace), [
      workflowKey,
    ]);
  });

  test("never rewrites an entry written by a newer ctrlyoke", async () => {
    const workflowKey = await createLineage("newer");
    const entry = await trash.trashLineage(workflowKey, REQUESTER);
    assert.ok(entry);
    const entryPath = path.join(
      WorkflowPaths.trashEntryDir(workspace, entry.id),
      "entry.json"
    );
    await fs.writeFile(
      entryPath,
      JSON.stringify({
        ...entry,
        schemaVersion:
          CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.HISTORY_TRASH_ENTRY] + 1,
      })
    );

    await assert.rejects(() => trash.restore(entry.id), NewerSchemaError);
    assert.strictEqual(
      await exists(WorkflowPaths.lineageDir(workspace, workflowKey)),
      false
    );
  });

  test("trash entry ids cannot escape the trash root", () => {
    assert.throws(() => WorkflowPaths.trashEntryDir(workspace, "../x"));
    assert.throws(() => WorkflowPaths.trashEntryDir(workspace, ""));
    assert.strictEqual(WorkflowPaths.isValidTrashEntryId("..\\x"), false);
  });

  test("toHistoryTrashedMessage carries the entry id for Undo", async () => {
    const entry = await trash.trashLineage(
      await createLineage("message"),
      REQUESTER
    );
    assert.ok(entry);
    assert.deepStrictEqual(toHistoryTrashedMessage(entry), {
      type: MESSAGE_TYPES.HISTORY_TRASHED,
      entryId: entry.id,
      kind: HISTORY_TRASH_ENTRY_KINDS.LINEAGE,
      message: 'Moved "message" to Recently deleted',
      skippedLive: [],
    });
  });
});
