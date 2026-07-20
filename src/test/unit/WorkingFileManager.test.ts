import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import type { IWorkingFileQueueAccess } from "../../core/WorkingFileManager";
import { PromptQueue } from "../../core/PromptQueue";
import type { PromptStep, WorkingFile } from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

// ─── Minimal mock for IWorkingFileQueueAccess ────────────────────────────────

function makeMockAccess(workingFilePath?: string): IWorkingFileQueueAccess {
  let definitionRevision = 1;
  return {
    getWorkingFilePath: () => workingFilePath,
    getSteps: () => [],
    getCurrentIndex: () => 0,
    getStatus: () => EXECUTION_STATES.IDLE,
    getWorkflowName: () => undefined,
    mergeDiskSteps: () => [],
    emitStateChange: () => {
      /* no-op */
    },
    getFinalStepRuntime: () => undefined,
    updateWorkflowProperty: () => {
      /* no-op */
    },
    getDefinitionRevision: () => definitionRevision,
    setDefinitionRevision: (revision: number) => {
      definitionRevision = revision;
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function writeTempJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function makeMinimalWorkingFile(): WorkingFile {
  return {
    workflowName: "test-workflow",
    startedAt: Date.now(),
    lastModifiedAt: Date.now(),
    definitionRevision: 1,
    steps: [{ prompt: "do the thing" }],
    _runtime: {
      currentIndex: 0,
      executionState: EXECUTION_STATES.IDLE,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

suite("WorkingFileManager", () => {
  const tempPaths: string[] = [];

  function tempFile(name?: string): string {
    const p = path.join(
      os.tmpdir(),
      `fp-wfm-${name ?? Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    tempPaths.push(p);
    return p;
  }

  afterEach(async () => {
    for (const p of tempPaths.splice(0)) {
      try {
        await fs.unlink(p);
      } catch {
        // best-effort cleanup
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("readWorkingFile", () => {
    test("parses valid JSON and returns WorkingFile structure", async () => {
      const manager = new WorkingFileManager(makeMockAccess());
      const workingFile = makeMinimalWorkingFile();
      const filePath = tempFile("valid");
      await writeTempJson(filePath, workingFile);

      const result = await manager.readWorkingFile(filePath);
      assert.strictEqual(result.workflowName, "test-workflow");
      assert.strictEqual(result.steps!.length, 1);
      assert.strictEqual(
        (result.steps![0] as PromptStep).prompt,
        "do the thing"
      );
    });

    test("rejects for a non-existent file path", async () => {
      const manager = new WorkingFileManager(makeMockAccess());
      const missing = path.join(os.tmpdir(), `fp-no-such-${Date.now()}.json`);
      await assert.rejects(
        () => manager.readWorkingFile(missing),
        /failed to read working file/i
      );
    });

    test("rejects for a file containing invalid JSON", async () => {
      const manager = new WorkingFileManager(makeMockAccess());
      const filePath = tempFile("invalid");
      await fs.writeFile(filePath, "{ this is: not valid JSON }", "utf-8");
      await assert.rejects(
        () => manager.readWorkingFile(filePath),
        /failed to read working file/i
      );
    });

    test("returns all prompt items from the file", async () => {
      const manager = new WorkingFileManager(makeMockAccess());
      const wf: WorkingFile = {
        ...makeMinimalWorkingFile(),
        steps: [
          { prompt: "step one" },
          { prompt: "step two" },
          { prompt: "step three" },
        ],
      };
      const filePath = tempFile("multi");
      await writeTempJson(filePath, wf);

      const result = await manager.readWorkingFile(filePath);
      assert.strictEqual(result.steps!.length, 3);
      assert.strictEqual((result.steps![2] as PromptStep).prompt, "step three");
    });

    test("preserves _runtime section", async () => {
      const manager = new WorkingFileManager(makeMockAccess());
      const wf: WorkingFile = {
        ...makeMinimalWorkingFile(),
        _runtime: {
          currentIndex: 2,
          executionState: EXECUTION_STATES.RUNNING,
        },
      };
      const filePath = tempFile("runtime");
      await writeTempJson(filePath, wf);

      const result = await manager.readWorkingFile(filePath);
      assert.strictEqual(result._runtime!.currentIndex, 2);
      assert.strictEqual(
        result._runtime!.executionState,
        EXECUTION_STATES.RUNNING
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("createWorkingFile", () => {
    let tmpWorkspace: string;

    async function makeTmpWorkspace(): Promise<string> {
      const ws = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-"));
      tempPaths.push(ws);
      return ws;
    }

    afterEach(async () => {
      if (tmpWorkspace) {
        await fs
          .rm(tmpWorkspace, { recursive: true, force: true })
          .catch(() => {});
      }
    });

    test("creates a draft file in .ctrlyoke/.runs/<workflowKey>/draft/ and returns its path + workflowKey", async () => {
      tmpWorkspace = await makeTmpWorkspace();

      const manager = new WorkingFileManager(makeMockAccess());
      const { workingFilePath, workflowKey } = await manager.createWorkingFile(
        "my-workflow",
        [{ prompt: "hello" }],
        tmpWorkspace,
        "my-workflow"
      );

      // File should exist
      await assert.doesNotReject(() => fs.access(workingFilePath));
      assert.ok(
        workingFilePath.endsWith("workflow.ctrlyoke.json"),
        `Expected workflow.ctrlyoke.json: ${workingFilePath}`
      );
      assert.ok(
        workingFilePath.includes(path.join(".runs", workflowKey, "draft")),
        `Expected path under .runs/${workflowKey}/draft: ${workingFilePath}`
      );
    });

    test("created file is valid JSON with expected workflow name and definitionRevision", async () => {
      tmpWorkspace = await makeTmpWorkspace();

      const manager = new WorkingFileManager(makeMockAccess());
      const { workingFilePath } = await manager.createWorkingFile(
        "test-run",
        [{ prompt: "step" }],
        tmpWorkspace,
        "test-workflow"
      );

      const content = await fs.readFile(workingFilePath, "utf-8");
      const parsed = JSON.parse(content) as WorkingFile;
      assert.strictEqual(parsed.workflowName, "test-workflow");
      assert.strictEqual(parsed.steps!.length, 1);
      assert.strictEqual(parsed.definitionRevision, 1);
    });

    test("updateWorkingFileDirect serializes the queue's current definitionRevision, not the disk value", async () => {
      tmpWorkspace = await makeTmpWorkspace();

      const { workingFilePath } = await new WorkingFileManager(
        makeMockAccess()
      ).createWorkingFile(
        "test-run",
        [{ prompt: "step" }],
        tmpWorkspace,
        "test-workflow"
      );

      const access = makeMockAccess(workingFilePath);
      access.setDefinitionRevision(3);
      await new WorkingFileManager(access).updateWorkingFileDirect();

      const content = await fs.readFile(workingFilePath, "utf-8");
      const parsed = JSON.parse(content) as WorkingFile;
      assert.strictEqual(parsed.definitionRevision, 3);
    });

    test("rejects a stale expected definition revision without writing", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const { workingFilePath } = await new WorkingFileManager(
        makeMockAccess()
      ).createWorkingFile(
        "conflict",
        [{ prompt: "disk" }],
        tmpWorkspace,
        "Conflict"
      );
      const access = makeMockAccess(workingFilePath);
      access.getSteps = () => [{ prompt: "stale client" }];
      access.getDefinitionRevision = () => 3;
      const manager = new WorkingFileManager(access);
      const before = await fs.readFile(workingFilePath, "utf8");

      manager.expectDefinitionRevision(2);
      await assert.rejects(
        () => manager.updateWorkingFile(true),
        /definition revision conflict/i
      );

      assert.strictEqual(await fs.readFile(workingFilePath, "utf8"), before);
    });

    test("workflowKey is sanitized — spaces and special chars replaced with hyphens", async () => {
      tmpWorkspace = await makeTmpWorkspace();

      const manager = new WorkingFileManager(makeMockAccess());
      const { workflowKey } = await manager.createWorkingFile(
        "My Workflow! With Spaces",
        [],
        tmpWorkspace,
        "My Workflow"
      );

      assert.ok(
        !/\s/.test(workflowKey),
        `workflowKey should not contain whitespace: ${workflowKey}`
      );
      assert.ok(
        !/[!]/.test(workflowKey),
        `workflowKey should not contain special chars: ${workflowKey}`
      );
    });

    test("workflowKey includes a timestamp segment", async () => {
      tmpWorkspace = await makeTmpWorkspace();

      const manager = new WorkingFileManager(makeMockAccess());
      const { workflowKey } = await manager.createWorkingFile(
        "timestamped",
        [],
        tmpWorkspace,
        "Timestamped"
      );

      // Format: <sanitized-name>-YYYY-MM-DDTHH-MM-SS
      assert.ok(
        /\d{4}-\d{2}-\d{2}T/.test(workflowKey),
        `Expected timestamp in workflowKey: ${workflowKey}`
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("seedNewRun", () => {
    let tmpWorkspace: string;

    async function makeTmpWorkspace(): Promise<string> {
      const ws = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-seed-"));
      tempPaths.push(ws);
      return ws;
    }

    afterEach(async () => {
      if (tmpWorkspace) {
        await fs
          .rm(tmpWorkspace, { recursive: true, force: true })
          .catch(() => {});
      }
    });

    /** Creates a lineage and promotes it to a first run with the given steps + status. */
    async function makeSourceRun(
      workspace: string,
      steps: WorkingFile["steps"],
      status: (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES]
    ): Promise<{ workflowKey: string; runRef: string }> {
      const access = makeMockAccess();
      const manager = new WorkingFileManager(access);
      const { workflowKey } = await manager.createWorkingFile(
        "source-workflow",
        steps ?? [],
        workspace,
        "Source Workflow"
      );

      const promotingAccess = makeMockAccess();
      promotingAccess.getSteps = () => steps ?? [];
      promotingAccess.getStatus = () => status;
      promotingAccess.getCurrentIndex = () => steps?.length ?? 0;
      const promotingManager = new WorkingFileManager(promotingAccess);
      const { runRef } = await promotingManager.promoteToNewRun(
        workspace,
        workflowKey as any,
        Date.now()
      );
      return { workflowKey, runRef };
    }

    test("seeds a new run from an existing run's persisted definition", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const steps: WorkingFile["steps"] = [
        { prompt: "first step", _runtime: { startedAt: 1, completedAt: 2 } },
      ] as WorkingFile["steps"];
      const { workflowKey, runRef } = await makeSourceRun(
        tmpWorkspace,
        steps,
        EXECUTION_STATES.COMPLETED
      );

      const seeded = await WorkingFileManager.seedNewRun(
        tmpWorkspace,
        workflowKey as any,
        runRef as any
      );

      assert.notStrictEqual(seeded.runRef, runRef);
      const content = JSON.parse(
        await fs.readFile(seeded.workingFilePath, "utf-8")
      ) as WorkingFile;
      assert.strictEqual(content.steps!.length, 1);
      assert.strictEqual(content.startedAt, seeded.startedAt);
      assert.strictEqual(
        (content.steps![0] as PromptStep).prompt,
        "first step"
      );
    });

    test("strips execution runtime from the workflow and every step", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const steps: WorkingFile["steps"] = [
        {
          prompt: "step one",
          _runtime: { startedAt: 1, completedAt: 2, responseText: "done" },
        },
      ] as WorkingFile["steps"];
      const { workflowKey, runRef } = await makeSourceRun(
        tmpWorkspace,
        steps,
        EXECUTION_STATES.COMPLETED
      );

      const seeded = await WorkingFileManager.seedNewRun(
        tmpWorkspace,
        workflowKey as any,
        runRef as any
      );
      const content = JSON.parse(
        await fs.readFile(seeded.workingFilePath, "utf-8")
      ) as WorkingFile;

      assert.strictEqual(content._runtime!.currentIndex, 0);
      assert.strictEqual(
        content._runtime!.executionState,
        EXECUTION_STATES.IDLE
      );
      assert.strictEqual((content.steps![0] as PromptStep)._runtime, undefined);
    });

    test("leaves the source run's file byte-for-byte unchanged", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const steps: WorkingFile["steps"] = [
        { prompt: "step one" },
      ] as WorkingFile["steps"];
      const { workflowKey, runRef } = await makeSourceRun(
        tmpWorkspace,
        steps,
        EXECUTION_STATES.COMPLETED
      );
      const sourcePath = path.join(
        tmpWorkspace,
        ".ctrlyoke",
        ".runs",
        workflowKey,
        runRef,
        "workflow.ctrlyoke.json"
      );
      const before = await fs.readFile(sourcePath, "utf-8");

      await WorkingFileManager.seedNewRun(
        tmpWorkspace,
        workflowKey as any,
        runRef as any
      );

      const after = await fs.readFile(sourcePath, "utf-8");
      assert.strictEqual(after, before);
    });

    test("applies harness/model overrides to the seeded run", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const steps: WorkingFile["steps"] = [
        { prompt: "step one" },
      ] as WorkingFile["steps"];
      const { workflowKey, runRef } = await makeSourceRun(
        tmpWorkspace,
        steps,
        EXECUTION_STATES.COMPLETED
      );

      const seeded = await WorkingFileManager.seedNewRun(
        tmpWorkspace,
        workflowKey as any,
        runRef as any,
        { harness: "claude-cli" as any, model: "opus" }
      );
      const content = JSON.parse(
        await fs.readFile(seeded.workingFilePath, "utf-8")
      ) as WorkingFile;

      assert.strictEqual(content.harness, "claude-cli");
      assert.strictEqual(content.model, "opus");
    });

    test("seeded run starts at definitionRevision 1", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const { workflowKey, runRef } = await makeSourceRun(
        tmpWorkspace,
        [{ prompt: "step" }] as WorkingFile["steps"],
        EXECUTION_STATES.COMPLETED
      );

      const seeded = await WorkingFileManager.seedNewRun(
        tmpWorkspace,
        workflowKey as any,
        runRef as any
      );
      const content = JSON.parse(
        await fs.readFile(seeded.workingFilePath, "utf-8")
      ) as WorkingFile;

      assert.strictEqual(content.definitionRevision, 1);
    });
  });

  suite("beginPendingRewind", () => {
    let tmpWorkspace: string;

    afterEach(async () => {
      if (tmpWorkspace) {
        await fs
          .rm(tmpWorkspace, { recursive: true, force: true })
          .catch(() => {});
      }
    });

    async function makeCompletedRun(): Promise<{
      workflowKey: import("../../types/CtrlYokeTypes").WorkflowKey;
      runRef: import("../../types/CtrlYokeTypes").RunRef;
      runFilePath: string;
    }> {
      tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-rewind-"));
      const manager = new WorkingFileManager(makeMockAccess());
      const { workflowKey } = await manager.createWorkingFile(
        "rewind-source",
        [
          { prompt: "prefix", _runtime: { startedAt: 1, completedAt: 2 } },
          { prompt: "suffix", _runtime: { startedAt: 3, completedAt: 4 } },
          { prompt: "tail", _runtime: { startedAt: 5, completedAt: 6 } },
        ],
        tmpWorkspace,
        "Rewind source"
      );
      const access = makeMockAccess();
      access.getSteps = () => [
        { prompt: "prefix", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "suffix", _runtime: { startedAt: 3, completedAt: 4 } },
        { prompt: "tail", _runtime: { startedAt: 5, completedAt: 6 } },
      ];
      access.getCurrentIndex = () => 3;
      access.getStatus = () => EXECUTION_STATES.COMPLETED;
      const promoted = await new WorkingFileManager(access).promoteToNewRun(
        tmpWorkspace,
        workflowKey,
        Date.now()
      );
      return {
        workflowKey,
        runRef: promoted.runRef,
        runFilePath: promoted.workingFilePath,
      };
    }

    test("atomically snapshots the source and clears only the requested suffix", async () => {
      const { workflowKey, runRef, runFilePath } = await makeCompletedRun();
      const before = await fs.readFile(runFilePath);

      const result = await WorkingFileManager.beginPendingRewind(
        tmpWorkspace,
        workflowKey,
        runRef,
        1,
        1,
        2
      );

      const after = JSON.parse(
        await fs.readFile(runFilePath, "utf8")
      ) as WorkingFile;
      const snapshot = await fs.readFile(
        WorkflowPaths.pendingRewindBaseFilePath(
          tmpWorkspace,
          workflowKey,
          runRef
        )
      );
      const descriptor = JSON.parse(
        await fs.readFile(
          WorkflowPaths.descriptorPath(tmpWorkspace, workflowKey),
          "utf8"
        )
      );
      assert.deepStrictEqual(
        snapshot,
        before,
        "recovery snapshot must retain exact source bytes"
      );
      assert.strictEqual(after.definitionRevision, 2);
      assert.ok(after.steps![0]._runtime?.completedAt);
      assert.strictEqual(after.steps![1]._runtime, undefined);
      assert.strictEqual(after.steps![2]._runtime, undefined);
      assert.deepStrictEqual(after._runtime?.pendingRewind, {
        fromStepIndex: 1,
        baseDefinitionRevision: 1,
      });
      assert.deepStrictEqual(descriptor.pendingEdit, {
        kind: "rewind",
        runRef,
        fromStepIndex: 1,
        baseDefinitionRevision: 1,
      });
      assert.strictEqual(result.definitionRevision, 2);
      assert.strictEqual(result.descriptorRevision, 3);
    });

    test("rejects stale revision pairs without changing the source run", async () => {
      const { workflowKey, runRef, runFilePath } = await makeCompletedRun();
      const before = await fs.readFile(runFilePath, "utf8");

      await assert.rejects(
        () =>
          WorkingFileManager.beginPendingRewind(
            tmpWorkspace,
            workflowKey,
            runRef,
            1,
            2,
            2
          ),
        /definition revision conflict/i
      );
      await assert.rejects(
        () =>
          WorkingFileManager.beginPendingRewind(
            tmpWorkspace,
            workflowKey,
            runRef,
            1,
            1,
            1
          ),
        /descriptor revision conflict/i
      );
      assert.strictEqual(await fs.readFile(runFilePath, "utf8"), before);
      await assert.rejects(
        () =>
          WorkingFileManager.seedNewRun(
            tmpWorkspace,
            workflowKey,
            runRef,
            {},
            undefined,
            { definitionRevision: 2, descriptorRevision: 2 }
          ),
        /definition revision conflict/i
      );
    });

    test("restores the durable pending rewind state after a process restart", async () => {
      const { workflowKey, runRef, runFilePath } = await makeCompletedRun();
      await WorkingFileManager.beginPendingRewind(
        tmpWorkspace,
        workflowKey,
        runRef,
        1,
        1,
        2
      );

      const restartedQueue = new PromptQueue();
      await restartedQueue.restoreFromWorkingFile(runFilePath);

      assert.deepStrictEqual(restartedQueue.getState().pendingRewind, {
        fromStepIndex: 1,
        baseDefinitionRevision: 1,
      });
      assert.strictEqual(restartedQueue.getState().currentIndex, 1);
      assert.ok(restartedQueue.getState().steps[0]._runtime?.completedAt);
      assert.strictEqual(
        restartedQueue.getState().steps[1]._runtime,
        undefined
      );
    });

    test("discards an unedited continuation by restoring the exact base snapshot", async () => {
      const { workflowKey, runRef, runFilePath } = await makeCompletedRun();
      const before = await fs.readFile(runFilePath, "utf8");
      await WorkingFileManager.beginPendingRewind(
        tmpWorkspace,
        workflowKey,
        runRef,
        1,
        1,
        2
      );

      const result = await WorkingFileManager.discardPendingRewind(
        tmpWorkspace,
        workflowKey,
        runRef,
        2,
        3
      );
      assert.strictEqual(result.discarded, true);
      assert.strictEqual(await fs.readFile(runFilePath, "utf8"), before);
      await assert.rejects(
        fs.readFile(
          WorkflowPaths.pendingRewindBaseFilePath(
            tmpWorkspace,
            workflowKey,
            runRef
          )
        )
      );
      const descriptor = JSON.parse(
        await fs.readFile(
          WorkflowPaths.descriptorPath(tmpWorkspace, workflowKey),
          "utf8"
        )
      );
      assert.strictEqual(descriptor.pendingEdit, undefined);
    });

    test("requires confirmation before discarding edited suffix content", async () => {
      const { workflowKey, runRef, runFilePath } = await makeCompletedRun();
      await WorkingFileManager.beginPendingRewind(
        tmpWorkspace,
        workflowKey,
        runRef,
        1,
        1,
        2
      );
      const edited = JSON.parse(
        await fs.readFile(runFilePath, "utf8")
      ) as WorkingFile;
      (edited.steps![1] as { prompt: string }).prompt = "edited suffix";
      edited.definitionRevision = 3;
      await fs.writeFile(runFilePath, JSON.stringify(edited, null, 2));

      const declined = await WorkingFileManager.discardPendingRewind(
        tmpWorkspace,
        workflowKey,
        runRef,
        3,
        3
      );
      assert.deepStrictEqual(declined, {
        discarded: false,
        hasSuffixEdits: true,
      });
      const accepted = await WorkingFileManager.discardPendingRewind(
        tmpWorkspace,
        workflowKey,
        runRef,
        3,
        3,
        true
      );
      assert.strictEqual(accepted.discarded, true);
      assert.ok(accepted.hasSuffixEdits);
    });
  });

  suite("appendTailToRun", () => {
    let workspace: string;

    afterEach(async () => {
      if (workspace) {
        await fs
          .rm(workspace, { recursive: true, force: true })
          .catch(() => {});
      }
    });

    test("preserves the exact executed prefix and appends only a runtime-free tail", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-append-"));
      const draft = new WorkingFileManager(makeMockAccess());
      const { workflowKey } = await draft.createWorkingFile(
        "append-source",
        [
          {
            prompt: "prefix",
            _runtime: {
              sessionId: "session-prefix",
              startedAt: 1,
              completedAt: 2,
            },
          },
        ],
        workspace,
        "Append source"
      );
      const access = makeMockAccess();
      access.getSteps = () => [
        {
          prompt: "prefix",
          _runtime: {
            sessionId: "session-prefix",
            startedAt: 1,
            completedAt: 2,
          },
        },
      ];
      access.getCurrentIndex = () => 1;
      access.getStatus = () => EXECUTION_STATES.COMPLETED;
      const promoted = await new WorkingFileManager(access).promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      const before = JSON.parse(
        await fs.readFile(promoted.workingFilePath, "utf8")
      ) as WorkingFile;

      const appended = await WorkingFileManager.appendTailToRun(
        workspace,
        workflowKey,
        promoted.runRef,
        [
          {
            prompt: "new tail",
            _runtime: { sessionId: "must-not-copy", startedAt: 1 },
          },
        ],
        1,
        2
      );

      const after = JSON.parse(
        await fs.readFile(promoted.workingFilePath, "utf8")
      ) as WorkingFile;
      assert.deepStrictEqual(after.steps![0], before.steps![0]);
      assert.strictEqual(after.steps!.length, 2);
      assert.strictEqual((after.steps![1]! as PromptStep).prompt, "new tail");
      assert.strictEqual(after.steps![1]!._runtime, undefined);
      assert.strictEqual(appended.definitionRevision, 2);
      await assert.rejects(
        () =>
          WorkingFileManager.appendTailToRun(
            workspace,
            workflowKey,
            promoted.runRef,
            [{ prompt: "conflict" }],
            1,
            3
          ),
        /Definition revision conflict/
      );
    });
  });

  suite("seedDraftFromRun", () => {
    let tmpWorkspace: string;

    afterEach(async () => {
      if (tmpWorkspace) {
        await fs
          .rm(tmpWorkspace, { recursive: true, force: true })
          .catch(() => {});
      }
    });

    test("copies an addressed run into a runtime-free draft without changing its source", async () => {
      tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-draft-"));
      const sourceManager = new WorkingFileManager(makeMockAccess());
      const { workflowKey } = await sourceManager.createWorkingFile(
        "draft-source",
        [{ prompt: "source", _runtime: { startedAt: 1 } }],
        tmpWorkspace,
        "Draft Source"
      );
      const access = makeMockAccess();
      access.getSteps = () => [
        { prompt: "source", _runtime: { startedAt: 1 } },
      ];
      const promoted = await new WorkingFileManager(access).promoteToNewRun(
        tmpWorkspace,
        workflowKey,
        Date.now()
      );
      const sourcePath = promoted.workingFilePath;
      const sourceBefore = await fs.readFile(sourcePath, "utf8");

      const draft = await WorkingFileManager.seedDraftFromRun(
        tmpWorkspace,
        workflowKey,
        promoted.runRef,
        1,
        2
      );
      const content = JSON.parse(
        await fs.readFile(draft.workingFilePath, "utf8")
      ) as WorkingFile;
      const descriptor = JSON.parse(
        await fs.readFile(
          path.join(
            tmpWorkspace,
            ".ctrlyoke",
            ".runs",
            workflowKey,
            "workflow.json"
          ),
          "utf8"
        )
      );

      assert.strictEqual((content.steps![0] as PromptStep)._runtime, undefined);
      assert.strictEqual(
        content._runtime?.executionState,
        EXECUTION_STATES.IDLE
      );
      assert.deepStrictEqual(descriptor.pendingEdit, { kind: "draft" });
      assert.strictEqual(descriptor.revision, 3);
      assert.strictEqual(await fs.readFile(sourcePath, "utf8"), sourceBefore);
    });

    test("rejects stale descriptor or source definition revisions", async () => {
      tmpWorkspace = await fs.mkdtemp(
        path.join(os.tmpdir(), "fp-ws-draft-conflict-")
      );
      const manager = new WorkingFileManager(makeMockAccess());
      const { workflowKey } = await manager.createWorkingFile(
        "draft-conflict",
        [{ prompt: "source" }],
        tmpWorkspace,
        "Draft Conflict"
      );
      const access = makeMockAccess();
      access.getSteps = () => [{ prompt: "source" }];
      const promoted = await new WorkingFileManager(access).promoteToNewRun(
        tmpWorkspace,
        workflowKey,
        Date.now()
      );

      await assert.rejects(
        () =>
          WorkingFileManager.seedDraftFromRun(
            tmpWorkspace,
            workflowKey,
            promoted.runRef,
            2,
            2
          ),
        /definition revision conflict/i
      );
      await assert.rejects(
        () =>
          WorkingFileManager.seedDraftFromRun(
            tmpWorkspace,
            workflowKey,
            promoted.runRef,
            1,
            1
          ),
        /descriptor revision conflict/i
      );
    });
  });
});
