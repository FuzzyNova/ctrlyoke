import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import type { IWorkingFileQueueAccess } from "../../core/WorkingFileManager";
import { PromptQueue } from "../../core/PromptQueue";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import type {
  PromptRuntimeMetadata,
  PromptStep,
  RunRef,
  WorkingFile,
  WorkingFileWorktreeRuntime,
  WorkflowKey,
  WorkflowTokenTotals,
} from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  clearRunSummaryCache,
  runSummaryCacheSize,
  stampRunFiles,
  storeRunSummary,
} from "../../core/orchestration/RunSummaryCache";
import type { RunSummaryRecord } from "../../core/orchestration/OutputHistoryManager";

// ─── Minimal mock for IWorkingFileQueueAccess ────────────────────────────────

function makeMockAccess(
  workingFilePath?: string,
  finalStepStepRuntime?: PromptRuntimeMetadata
): IWorkingFileQueueAccess {
  let definitionRevision = 1;
  return {
    getWorkingFilePath: () => workingFilePath,
    getSteps: () => [],
    getCurrentIndex: () => 0,
    getStatus: () => EXECUTION_STATES.IDLE,
    getRuntimeState: () => ({
      status: EXECUTION_STATES.IDLE,
      stopped: false,
      totalPausedDuration: 0,
    }),
    getWorkflowName: () => undefined,
    mergeDiskSteps: () => [],
    emitStateChange: () => {
      /* no-op */
    },
    getFinalStepRuntime: () => undefined,
    getFinalStepExecutionMetadata: () => finalStepStepRuntime,
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

function makeWorktreeRuntime(): WorkingFileWorktreeRuntime {
  const worktreeRoot = path.join(os.tmpdir(), "named-worktree");
  return {
    schemaVersion: 1,
    mode: "named",
    origin: "discovered",
    branchName: "feature/runtime",
    worktreePath: worktreeRoot,
    executionRoot: worktreeRoot,
    executionCheckoutRoot: worktreeRoot,
    sourceCheckoutRoot: path.join(os.tmpdir(), "source-checkout"),
    namedWorkspaceRoots: [{ name: "root", fsPath: worktreeRoot }],
    baseCommit: "abc123",
    lifecycleOwner: "user",
    lifecycleState: "ready",
    setupOutcome: "succeeded",
    directoryState: "present",
    branchState: "present",
    updatedAt: 100,
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

  test("publishes a promoted run only after all three run artifacts exist", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-staged-run-")
    );
    try {
      const repository = new WorkflowLineageRepository();
      const lineage = await repository.createLineage(
        workspaceRoot,
        "staged-run",
        "Staged run"
      );
      const allocation = await repository.allocateRun(
        workspaceRoot,
        lineage.workflowKey
      );

      await assert.rejects(fs.access(allocation.runDir));
      await fs.writeFile(allocation.stagingRunFilePath, "{}");
      await fs.writeFile(
        path.join(allocation.stagingRunDir, "manifest.json"),
        "{}"
      );
      await fs.writeFile(
        path.join(allocation.stagingRunDir, "events.jsonl"),
        ""
      );
      await repository.finalizeAllocatedRun(
        workspaceRoot,
        lineage.workflowKey,
        allocation
      );

      await Promise.all([
        fs.access(allocation.runFilePath),
        fs.access(path.join(allocation.runDir, "manifest.json")),
        fs.access(path.join(allocation.runDir, "events.jsonl")),
      ]);
      const descriptor = await repository.readDescriptor(
        workspaceRoot,
        lineage.workflowKey
      );
      assert.strictEqual(descriptor.latestRunRef, allocation.runRef);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
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

  test("persists finalStep per-step runtime without replacing its definition", async () => {
    const workingFilePath = tempFile("final-step-runtime");
    const workingFile = makeMinimalWorkingFile();
    workingFile.finalStep = {
      prompt: "disk-authoritative final prompt",
      model: "gpt-5.4-mini",
    };
    await writeTempJson(workingFilePath, workingFile);

    const finalStepRuntime: PromptRuntimeMetadata = {
      startedAt: 123,
      harness: "codex-cli",
      model: "gpt-5.4-mini",
      sessionId: "final-session-id",
    };
    const manager = new WorkingFileManager(
      makeMockAccess(workingFilePath, finalStepRuntime)
    );

    await manager.updateWorkingFile();

    const persisted = JSON.parse(
      await fs.readFile(workingFilePath, "utf-8")
    ) as WorkingFile;
    assert.deepStrictEqual(persisted.finalStep, {
      prompt: "disk-authoritative final prompt",
      model: "gpt-5.4-mini",
      _runtime: finalStepRuntime,
    });
  });

  test("persists a finalStep session ID through PromptQueue", async () => {
    const workingFilePath = tempFile("final-step-session");
    const workingFile = makeMinimalWorkingFile();
    workingFile.finalStep = { prompt: "final prompt" };
    await writeTempJson(workingFilePath, workingFile);

    const queue = new PromptQueue();
    queue.loadPrompts(workingFile, workingFilePath);

    await queue.persistSessionId(workingFile.steps!.length, "final-session-id");

    const persisted = JSON.parse(
      await fs.readFile(workingFilePath, "utf-8")
    ) as WorkingFile;
    assert.strictEqual(
      persisted.finalStep?._runtime?.sessionId,
      "final-session-id"
    );
    assert.strictEqual(
      typeof persisted.finalStep?._runtime?.startedAt,
      "number"
    );
  });

  test("projects token totals through a later PromptQueue runtime write", async () => {
    const workingFilePath = tempFile("token-total-runtime");
    const workingFile = makeMinimalWorkingFile();
    await writeTempJson(workingFilePath, workingFile);

    const queue = new PromptQueue();
    queue.loadPrompts(workingFile, workingFilePath);
    queue.setTokenTotals({
      total: 12,
      coverage: "complete",
      reportedAttemptCount: 1,
      attemptCount: 1,
      isFinal: false,
      byHarness: {},
      byLocalDay: {},
    });
    await queue.commitRuntimeTransition();

    const persisted = JSON.parse(
      await fs.readFile(workingFilePath, "utf-8")
    ) as WorkingFile;
    assert.strictEqual(persisted._runtime?.tokenTotals?.total, 12);
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

    test("updateWorkingFileDirect persists pause-aware execution timing", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const { workingFilePath } = await new WorkingFileManager(
        makeMockAccess()
      ).createWorkingFile(
        "timed-run",
        [{ prompt: "step" }],
        tmpWorkspace,
        "timed-workflow"
      );
      const access = makeMockAccess(workingFilePath);
      access.getStatus = () => EXECUTION_STATES.PAUSED;
      access.getRuntimeState = () => ({
        status: EXECUTION_STATES.PAUSED,
        stopped: false,
        startTime: 1_000,
        pausedTime: 1_600,
        totalPausedDuration: 200,
        executionEndTime: undefined,
      });

      await new WorkingFileManager(access).updateWorkingFileDirect();

      const parsed = JSON.parse(
        await fs.readFile(workingFilePath, "utf-8")
      ) as WorkingFile;
      assert.deepStrictEqual(parsed._runtime, {
        currentIndex: 0,
        executionState: EXECUTION_STATES.PAUSED,
        startTime: 1_000,
        pausedTime: 1_600,
        totalPausedDuration: 200,
      });
    });

    test("preserves the disk worktree runtime across ordinary runtime writes", async () => {
      const workingFilePath = tempFile("worktree-preserve");
      const worktree = makeWorktreeRuntime();
      await writeTempJson(workingFilePath, {
        ...makeMinimalWorkingFile(),
        definitionRevision: 7,
        _runtime: {
          currentIndex: 2,
          executionState: EXECUTION_STATES.RUNNING,
          worktree,
        },
      });

      const access = makeMockAccess(workingFilePath);
      access.getCurrentIndex = () => 3;
      access.getStatus = () => EXECUTION_STATES.PAUSED;
      access.getDefinitionRevision = () => 7;
      await new WorkingFileManager(access).updateWorkingFileDirect();

      const persisted = JSON.parse(
        await fs.readFile(workingFilePath, "utf-8")
      ) as WorkingFile;
      assert.deepStrictEqual(persisted._runtime?.worktree, worktree);
      assert.strictEqual(persisted._runtime?.currentIndex, 3);
      assert.strictEqual(
        persisted._runtime?.executionState,
        EXECUTION_STATES.PAUSED
      );
      assert.strictEqual(persisted.definitionRevision, 7);
    });

    test("atomically patches worktree runtime without disturbing queue runtime or definition revision", async () => {
      const workingFilePath = tempFile("worktree-patch");
      const worktree = makeWorktreeRuntime();
      await writeTempJson(workingFilePath, {
        ...makeMinimalWorkingFile(),
        definitionRevision: 9,
        _runtime: {
          currentIndex: 4,
          executionState: EXECUTION_STATES.RUNNING,
          startTime: 123,
          worktree,
        },
      });

      const access = makeMockAccess(workingFilePath);
      access.getDefinitionRevision = () => 9;
      const manager = new WorkingFileManager(access);
      await manager.updateWorktreeRuntime({
        lifecycleState: "settled",
        landingOutcome: "no-changes",
        updatedAt: 200,
      });

      const persisted = JSON.parse(
        await fs.readFile(workingFilePath, "utf-8")
      ) as WorkingFile;
      assert.deepStrictEqual(persisted._runtime, {
        currentIndex: 4,
        executionState: EXECUTION_STATES.RUNNING,
        startTime: 123,
        worktree: {
          ...worktree,
          lifecycleState: "settled",
          landingOutcome: "no-changes",
          updatedAt: 200,
        },
      });
      assert.strictEqual(persisted.definitionRevision, 9);
      assert.strictEqual(access.getDefinitionRevision(), 9);
    });

    test("invalidates the run summary cache when worktree runtime changes", async () => {
      clearRunSummaryCache();
      const workingFilePath = tempFile("worktree-cache-invalidation");
      const baseWorkingFile = makeMinimalWorkingFile();
      await writeTempJson(workingFilePath, {
        ...baseWorkingFile,
        _runtime: {
          ...baseWorkingFile._runtime,
          worktree: makeWorktreeRuntime(),
        },
      });
      const runDirectoryPath = path.dirname(workingFilePath);
      const record = {
        manifestExecutionState: EXECUTION_STATES.COMPLETED,
        summary: {
          workflowKey: "cache-lineage" as WorkflowKey,
          runRef: "run-1" as RunRef,
          runId: 1,
          startedAt: 1,
          executionState: EXECUTION_STATES.COMPLETED,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      } satisfies RunSummaryRecord;
      storeRunSummary(
        runDirectoryPath,
        await stampRunFiles(
          path.join(runDirectoryPath, "manifest.json"),
          workingFilePath
        ),
        record
      );
      assert.strictEqual(runSummaryCacheSize(), 1);

      await new WorkingFileManager(
        makeMockAccess(workingFilePath)
      ).updateWorktreeRuntime({ lifecycleState: "settled" });

      assert.strictEqual(runSummaryCacheSize(), 0);
      clearRunSummaryCache();
    });

    test("preserves an externally appended tail's disk revision during a runtime flush", async () => {
      const workingFilePath = tempFile("external-tail-revision");
      await writeTempJson(workingFilePath, {
        ...makeMinimalWorkingFile(),
        definitionRevision: 5,
        steps: [{ prompt: "first" }, { prompt: "external tail" }],
      });

      const access = makeMockAccess(workingFilePath);
      let memorySteps: PromptStep[] = [{ prompt: "first" }];
      let definitionRevision = 4;
      access.getSteps = () => memorySteps;
      access.getDefinitionRevision = () => definitionRevision;
      access.setDefinitionRevision = (revision: number) => {
        definitionRevision = revision;
      };
      access.mergeDiskSteps = (diskSteps) => {
        memorySteps = diskSteps as PromptStep[];
        return [diskSteps[1]!];
      };

      await new WorkingFileManager(access).updateWorkingFileDirect();

      const persisted = JSON.parse(
        await fs.readFile(workingFilePath, "utf-8")
      ) as WorkingFile;
      assert.strictEqual(definitionRevision, 5);
      assert.strictEqual(persisted.definitionRevision, 5);
      assert.strictEqual(persisted.steps!.length, 2);
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
  suite("promoteToNewRun", () => {
    let tmpWorkspace: string;

    afterEach(async () => {
      if (tmpWorkspace) {
        await fs
          .rm(tmpWorkspace, { recursive: true, force: true })
          .catch(() => {});
      }
    });

    // The draft is a session's worth of the user's work and the run is built
    // from it, so publishing must be all-or-nothing: stage the run's files,
    // rename them into place, and only then delete the draft. A promotion that
    // fails anywhere before that rename must leave the draft exactly as it was
    // — there is nowhere else the definition exists yet.
    test("keeps the draft intact when publishing the run fails", async () => {
      tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-promote-"));
      tempPaths.push(tmpWorkspace);

      const creator = new WorkingFileManager(makeMockAccess());
      const { workflowKey, workingFilePath } = await creator.createWorkingFile(
        "doomed-workflow",
        [{ prompt: "an hour of tweaking" }] as PromptStep[],
        tmpWorkspace,
        "Doomed Workflow"
      );
      const draftBefore = await fs.readFile(workingFilePath, "utf-8");

      const failingRepository = new WorkflowLineageRepository();
      failingRepository.finalizeAllocatedRun = async () => {
        throw new Error("publish failed");
      };
      const access = makeMockAccess(workingFilePath);
      access.getSteps = () =>
        [{ prompt: "an hour of tweaking" }] as PromptStep[];

      await assert.rejects(
        new WorkingFileManager(access, failingRepository).promoteToNewRun(
          tmpWorkspace,
          workflowKey as any,
          Date.now()
        ),
        /publish failed/
      );

      assert.strictEqual(
        await fs.readFile(workingFilePath, "utf-8"),
        draftBefore,
        "a failed promotion must not touch the draft it was promoting"
      );
      const runsDir = path.dirname(path.dirname(workingFilePath));
      const published = (await fs.readdir(runsDir)).filter((entry) =>
        entry.startsWith("run-")
      );
      assert.deepStrictEqual(
        published,
        [],
        "no run may be published when finalization failed"
      );
    });

    test("carries the draft's workflow settings into the first run", async () => {
      tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-promote-"));
      tempPaths.push(tmpWorkspace);

      const creator = new WorkingFileManager(makeMockAccess());
      const { workflowKey, workingFilePath } = await creator.createWorkingFile(
        "settings-workflow",
        [],
        tmpWorkspace,
        "Settings Workflow"
      );
      // Workflow-level settings live only in the definition file; the queue
      // knows nothing about them, so promotion must merge the head it is
      // bound to rather than rebuilding the file from queue state alone.
      const draftAccess = makeMockAccess(workingFilePath);
      const draftManager = new WorkingFileManager(draftAccess);
      await draftManager.updateWorkingFileProperties({
        harness: "claude-cli",
        model: "claude-opus-4-8",
        finalStep: { prompt: "wrap up" },
      });

      const steps = [{ prompt: "only step" }] as WorkingFile["steps"];
      const promotingAccess = makeMockAccess(workingFilePath);
      promotingAccess.getSteps = () => steps ?? [];
      const promoted = await new WorkingFileManager(
        promotingAccess
      ).promoteToNewRun(tmpWorkspace, workflowKey as any, Date.now());

      const run = JSON.parse(
        await fs.readFile(promoted.workingFilePath, "utf-8")
      ) as WorkingFile;
      assert.strictEqual(run.harness, "claude-cli");
      assert.strictEqual(run.model, "claude-opus-4-8");
      assert.deepStrictEqual(run.finalStep, { prompt: "wrap up" });
      // Queue state still wins for topology and the new run's own revision.
      assert.deepStrictEqual(
        run.steps?.map((step) => (step as { prompt?: string }).prompt),
        ["only step"]
      );
      assert.strictEqual(run.definitionRevision, 1);
    });

    test("preserves the authored worktree definition but starts without old runtime metadata", async () => {
      tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-promote-"));
      tempPaths.push(tmpWorkspace);

      const creator = new WorkingFileManager(makeMockAccess());
      const { workflowKey, workingFilePath } = await creator.createWorkingFile(
        "worktree-promotion",
        [{ prompt: "step" }],
        tmpWorkspace,
        "Worktree promotion"
      );
      const draftManager = new WorkingFileManager(
        makeMockAccess(workingFilePath)
      );
      await draftManager.updateWorkingFileProperties({
        worktree: "feature/runtime",
      });
      await draftManager.updateWorktreeRuntime(makeWorktreeRuntime());

      const promoted = await new WorkingFileManager(
        makeMockAccess(workingFilePath)
      ).promoteToNewRun(tmpWorkspace, workflowKey as any, Date.now());
      const run = JSON.parse(
        await fs.readFile(promoted.workingFilePath, "utf-8")
      ) as WorkingFile;
      assert.strictEqual(run.worktree, "feature/runtime");
      assert.strictEqual(run._runtime?.worktree, undefined);
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
          _runtime: { startedAt: 1, completedAt: 2 },
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

    test("keeps the authored worktree definition but strips worktree runtime on re-run", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const { workflowKey, runRef } = await makeSourceRun(
        tmpWorkspace,
        [{ prompt: "step" }],
        EXECUTION_STATES.COMPLETED
      );
      const sourcePath = WorkflowPaths.runFilePath(
        tmpWorkspace,
        workflowKey as any,
        runRef as any
      );
      const source = JSON.parse(
        await fs.readFile(sourcePath, "utf8")
      ) as WorkingFile;
      source.worktree = { mode: "named", branch: "feature/runtime" };
      source._runtime = {
        ...(source._runtime ?? {
          currentIndex: 1,
          executionState: EXECUTION_STATES.COMPLETED,
        }),
        worktree: makeWorktreeRuntime(),
      };
      await writeTempJson(sourcePath, source);

      const seeded = await WorkingFileManager.seedNewRun(
        tmpWorkspace,
        workflowKey as any,
        runRef as any
      );
      const content = JSON.parse(
        await fs.readFile(seeded.workingFilePath, "utf-8")
      ) as WorkingFile;
      assert.deepStrictEqual(content.worktree, source.worktree);
      assert.strictEqual(content._runtime?.worktree, undefined);
    });

    test("does not copy run token totals into a seeded run", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const { workflowKey, runRef } = await makeSourceRun(
        tmpWorkspace,
        [{ prompt: "step one" }],
        EXECUTION_STATES.COMPLETED
      );
      const sourcePath = WorkflowPaths.runFilePath(
        tmpWorkspace,
        workflowKey as any,
        runRef as any
      );
      const source = JSON.parse(await fs.readFile(sourcePath, "utf8")) as WorkingFile;
      const tokenTotals: WorkflowTokenTotals = {
        total: 7,
        coverage: "complete",
        reportedAttemptCount: 1,
        attemptCount: 1,
        isFinal: true,
        byHarness: {},
        byLocalDay: {},
      };
      source._runtime = { ...source._runtime!, tokenTotals };
      await writeTempJson(sourcePath, source);

      const seeded = await WorkingFileManager.seedNewRun(
        tmpWorkspace,
        workflowKey as any,
        runRef as any
      );
      const content = JSON.parse(
        await fs.readFile(seeded.workingFilePath, "utf-8")
      ) as WorkingFile;
      assert.strictEqual(content._runtime?.tokenTotals, undefined);
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
      const sourcePath = WorkflowPaths.runFilePath(
        tmpWorkspace,
        workflowKey as WorkflowKey,
        runRef as RunRef
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

    // The manifest is what the dashboard's run list badges, and
    // `TimelineRecorder.initializeRunAt` is a no-op once manifest+events exist,
    // so an executing caller never gets a second chance to correct this. A seed
    // that is not executed (Set start position on the first step) must not
    // advertise a live run.
    test("records the seeded run's manifest state from the caller", async () => {
      tmpWorkspace = await makeTmpWorkspace();
      const { workflowKey, runRef } = await makeSourceRun(
        tmpWorkspace,
        [{ prompt: "step" }] as WorkingFile["steps"],
        EXECUTION_STATES.COMPLETED
      );
      const readManifestState = async (seededRunRef: string) =>
        (
          JSON.parse(
            await fs.readFile(
              WorkflowPaths.manifestPath(
                tmpWorkspace,
                workflowKey as WorkflowKey,
                seededRunRef as RunRef
              ),
              "utf-8"
            )
          ) as { executionState: string }
        ).executionState;

      const idle = await WorkingFileManager.seedNewRun(
        tmpWorkspace,
        workflowKey as any,
        runRef as any
      );
      assert.strictEqual(
        await readManifestState(idle.runRef),
        EXECUTION_STATES.IDLE
      );

      const running = await WorkingFileManager.seedNewRun(
        tmpWorkspace,
        workflowKey as any,
        runRef as any,
        {},
        undefined,
        undefined,
        EXECUTION_STATES.RUNNING
      );
      assert.strictEqual(
        await readManifestState(running.runRef),
        EXECUTION_STATES.RUNNING
      );
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

  suite("appendStepsToRun", () => {
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

      const appended = await WorkingFileManager.appendStepsToRun(
        workspace,
        workflowKey,
        promoted.runRef,
        [
          {
            prompt: "new tail",
            _runtime: { sessionId: "must-not-copy", startedAt: 1 },
          },
        ],
        1
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
          WorkingFileManager.appendStepsToRun(
            workspace,
            workflowKey,
            promoted.runRef,
            [{ prompt: "conflict" }],
            1
          ),
        /Definition revision conflict/
      );
    });
  });

  suite("addressed run-head mutation primitives", () => {
    let workspace: string;

    afterEach(async () => {
      if (workspace) {
        await fs
          .rm(workspace, { recursive: true, force: true })
          .catch(() => {});
      }
    });

    async function makeIdleRun(
      status: (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES] = EXECUTION_STATES.COMPLETED
    ): Promise<{
      workflowKey: import("../../types/CtrlYokeTypes").WorkflowKey;
      runRef: import("../../types/CtrlYokeTypes").RunRef;
      runFilePath: string;
    }> {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-addressed-"));
      const draft = new WorkingFileManager(makeMockAccess());
      const { workflowKey } = await draft.createWorkingFile(
        "addressed-source",
        [
          { prompt: "first", _runtime: { startedAt: 1, completedAt: 2 } },
          { prompt: "second", _runtime: { startedAt: 3, completedAt: 4 } },
        ],
        workspace,
        "Addressed source"
      );
      const access = makeMockAccess();
      access.getSteps = () => [
        { prompt: "first", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "second", _runtime: { startedAt: 3, completedAt: 4 } },
      ];
      access.getCurrentIndex = () => 2;
      access.getStatus = () => status;
      const promoted = await new WorkingFileManager(access).promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      return {
        workflowKey,
        runRef: promoted.runRef,
        runFilePath: promoted.workingFilePath,
      };
    }

    test("insertStepAtRun splices the step and shifts currentIndex, bumping the definition revision only", async () => {
      const { workflowKey, runRef, runFilePath } = await makeIdleRun();

      const result = await WorkingFileManager.insertStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        { prompt: "inserted" },
        1
      );

      assert.strictEqual(result.definitionRevision, 2);
      // The descriptor is untouched by an ordinary run-content edit: it stays
      // at whatever it was after `promoteToNewRun` allocated this run.
      assert.strictEqual(result.descriptorRevision, 2);
      const after = JSON.parse(
        await fs.readFile(runFilePath, "utf8")
      ) as WorkingFile;
      assert.strictEqual(after.steps!.length, 3);
      assert.strictEqual((after.steps![1] as PromptStep).prompt, "inserted");
      assert.strictEqual(after._runtime?.currentIndex, 3);

      await assert.rejects(
        () =>
          WorkingFileManager.insertStepAtRun(
            workspace,
            workflowKey,
            runRef,
            0,
            { prompt: "stale" },
            1
          ),
        /Definition revision conflict/
      );
    });

    test("updateStepAtRun merges updates and supports a full replace", async () => {
      const { workflowKey, runRef, runFilePath } = await makeIdleRun();

      const merged = await WorkingFileManager.updateStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        { updates: { prompt: "first (edited)" } },
        1
      );
      assert.strictEqual(
        (merged.workingFile.steps![0] as PromptStep).prompt,
        "first (edited)"
      );
      assert.ok(
        merged.workingFile.steps![0]._runtime?.completedAt,
        "merge must not drop existing runtime"
      );

      const replaced = await WorkingFileManager.updateStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        { replace: { prompt: "replaced entirely" } },
        2
      );
      assert.strictEqual(
        (replaced.workingFile.steps![0] as PromptStep).prompt,
        "replaced entirely"
      );
      assert.strictEqual(replaced.workingFile.steps![0]._runtime, undefined);

      const after = JSON.parse(
        await fs.readFile(runFilePath, "utf8")
      ) as WorkingFile;
      assert.strictEqual(after.definitionRevision, 3);
    });

    test("deleteStepAtRun removes the step and shifts currentIndex", async () => {
      const { workflowKey, runRef, runFilePath } = await makeIdleRun();

      const result = await WorkingFileManager.deleteStepAtRun(
        workspace,
        workflowKey,
        runRef,
        0,
        1
      );

      assert.strictEqual(result.workingFile.steps!.length, 1);
      assert.strictEqual(
        (result.workingFile.steps![0] as PromptStep).prompt,
        "second"
      );
      assert.strictEqual(result.workingFile._runtime?.currentIndex, 1);
      const after = JSON.parse(
        await fs.readFile(runFilePath, "utf8")
      ) as WorkingFile;
      assert.strictEqual(after.definitionRevision, 2);
    });

    test("reorderStepsAtRun reorders only the pending suffix", async () => {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-addressed-"));
      const draft = new WorkingFileManager(makeMockAccess());
      const { workflowKey } = await draft.createWorkingFile(
        "reorder-source",
        [
          { prompt: "done", _runtime: { startedAt: 1, completedAt: 2 } },
          { prompt: "pending-a" },
          { prompt: "pending-b" },
        ],
        workspace,
        "Reorder source"
      );
      const access = makeMockAccess();
      access.getSteps = () => [
        { prompt: "done", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "pending-a" },
        { prompt: "pending-b" },
      ];
      access.getCurrentIndex = () => 1;
      access.getStatus = () => EXECUTION_STATES.PAUSED;
      const promoted = await new WorkingFileManager(access).promoteToNewRun(
        workspace,
        workflowKey,
        Date.now()
      );
      // Reordering runs against an idle definition head; stop() the runtime
      // marker down to COMPLETED so the addressed-mutation execution-state
      // guard (RUNNING/PAUSING/CANCELLING/PAUSED all rejected) doesn't fire —
      // only the pending-suffix split (currentIndex=1) matters for this test.
      const idleFile = JSON.parse(
        await fs.readFile(promoted.workingFilePath, "utf8")
      ) as WorkingFile;
      idleFile._runtime = {
        ...idleFile._runtime!,
        executionState: EXECUTION_STATES.STOPPED,
      };
      await fs.writeFile(
        promoted.workingFilePath,
        JSON.stringify(idleFile, null, 2)
      );

      const result = await WorkingFileManager.reorderStepsAtRun(
        workspace,
        workflowKey,
        promoted.runRef,
        [1, 0],
        1
      );

      assert.strictEqual(result.workingFile.steps!.length, 3);
      assert.strictEqual(
        (result.workingFile.steps![0] as PromptStep).prompt,
        "done"
      );
      assert.strictEqual(
        (result.workingFile.steps![1] as PromptStep).prompt,
        "pending-b"
      );
      assert.strictEqual(
        (result.workingFile.steps![2] as PromptStep).prompt,
        "pending-a"
      );
    });

    test("syncStepsForUndoRedoAtRun preserves existing runtime for unchanged-position steps", async () => {
      const { workflowKey, runRef } = await makeIdleRun();

      const result = await WorkingFileManager.syncStepsForUndoRedoAtRun(
        workspace,
        workflowKey,
        runRef,
        [{ prompt: "first" }, { prompt: "second (renamed)" }],
        1
      );

      assert.ok(result.workingFile.steps![0]._runtime?.completedAt);
      assert.strictEqual(
        (result.workingFile.steps![1] as PromptStep).prompt,
        "second (renamed)"
      );
      assert.ok(result.workingFile.steps![1]._runtime?.completedAt);
    });

    test("updatePropertiesAtRun applies a diff and updateWorkflowNameAtRun renames", async () => {
      const { workflowKey, runRef } = await makeIdleRun();

      const properties = await WorkingFileManager.updatePropertiesAtRun(
        workspace,
        workflowKey,
        runRef,
        { harness: "claude-cli" },
        1
      );
      assert.deepStrictEqual(properties.appliedKeys, ["harness"]);
      assert.strictEqual(properties.workingFile.harness, "claude-cli");

      const renamed = await WorkingFileManager.updateWorkflowNameAtRun(
        workspace,
        workflowKey,
        runRef,
        "Renamed run",
        2
      );
      assert.strictEqual(renamed.workingFile.workflowName, "Renamed run");
    });

    test("rejects an addressed edit while the run is RUNNING", async () => {
      const { workflowKey, runRef } = await makeIdleRun(
        EXECUTION_STATES.RUNNING
      );

      await assert.rejects(
        () =>
          WorkingFileManager.insertStepAtRun(
            workspace,
            workflowKey,
            runRef,
            0,
            { prompt: "should not land" },
            1
          ),
        /Cannot edit while run is in state/
      );
    });

    test("property edits pass through a pending rewind on this run; step-topology edits stay blocked", async () => {
      const { workflowKey, runRef } = await makeIdleRun();
      await WorkingFileManager.beginPendingRewind(
        workspace,
        workflowKey,
        runRef,
        1,
        1,
        2
      );

      const properties = await WorkingFileManager.updatePropertiesAtRun(
        workspace,
        workflowKey,
        runRef,
        { harness: "codex-cli" },
        2
      );
      assert.strictEqual(properties.workingFile.harness, "codex-cli");

      await assert.rejects(
        () =>
          WorkingFileManager.insertStepAtRun(
            workspace,
            workflowKey,
            runRef,
            0,
            { prompt: "blocked during rewind" },
            3
          ),
        /draft or pending continuation/
      );
    });

    test("instance-bound property edit succeeds during a pending rewind and its value survives (Continue path)", async () => {
      const { workflowKey, runRef, runFilePath } = await makeIdleRun();
      await WorkingFileManager.beginPendingRewind(
        workspace,
        workflowKey,
        runRef,
        1,
        1,
        2
      );

      const access = makeMockAccess(runFilePath);
      const instanceManager = new WorkingFileManager(access);
      instanceManager.expectDefinitionRevision(2);
      const result = await instanceManager.updateWorkingFileProperties({
        harness: "codex-cli",
      });

      assert.strictEqual(result?.workingFile.harness, "codex-cli");
      const onDisk = JSON.parse(
        await fs.readFile(runFilePath, "utf8")
      ) as WorkingFile;
      assert.strictEqual(onDisk.harness, "codex-cli");
      assert.ok(
        onDisk._runtime?.pendingRewind,
        "pending rewind stays active until Continue/Discard explicitly resolves it"
      );
    });

    test("Discard after an instance-bound property edit made during a pending rewind reverts the property, not just the suffix", async () => {
      const { workflowKey, runRef, runFilePath } = await makeIdleRun();
      const beforeRewind = JSON.parse(
        await fs.readFile(runFilePath, "utf8")
      ) as WorkingFile;
      assert.strictEqual(beforeRewind.harness, undefined);

      await WorkingFileManager.beginPendingRewind(
        workspace,
        workflowKey,
        runRef,
        1,
        1,
        2
      );

      const access = makeMockAccess(runFilePath);
      const instanceManager = new WorkingFileManager(access);
      instanceManager.expectDefinitionRevision(2);
      await instanceManager.updateWorkingFileProperties({
        harness: "codex-cli",
      });

      const discarded = await WorkingFileManager.discardPendingRewind(
        workspace,
        workflowKey,
        runRef,
        3,
        3
      );

      assert.strictEqual(discarded.discarded, true);
      if (discarded.discarded) {
        assert.strictEqual(discarded.workingFile.harness, beforeRewind.harness);
      }
      const onDisk = JSON.parse(
        await fs.readFile(runFilePath, "utf8")
      ) as WorkingFile;
      assert.strictEqual(onDisk.harness, beforeRewind.harness);
    });
  });
});

suite("WorkingFileManager one-shot definition revision expectation", () => {
  let workspace: string;

  afterEach(async () => {
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("does not carry a rejected expectation into the next write", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-expectation-"));
    const workingFilePath = path.join(workspace, "workflow.ctrlyoke.json");
    await writeTempJson(workingFilePath, makeMinimalWorkingFile());
    const manager = new WorkingFileManager(makeMockAccess(workingFilePath));

    manager.expectDefinitionRevision(9);
    await assert.rejects(
      () => manager.updateWorkingFileProperties({ harness: "claude-cli" }),
      /Definition revision conflict/
    );

    // The stale expectation must not survive to guard an unrelated later write.
    const result = await manager.updateWorkingFileProperties({
      harness: "claude-cli",
    });
    assert.strictEqual(result?.workingFile.harness, "claude-cli");
    assert.strictEqual(result?.workingFile.definitionRevision, 2);
  });

  test("does not carry an expectation past a write that changed nothing", async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-expectation-"));
    const workingFilePath = path.join(workspace, "workflow.ctrlyoke.json");
    await writeTempJson(workingFilePath, {
      ...makeMinimalWorkingFile(),
      harness: "claude-cli",
    });
    const manager = new WorkingFileManager(makeMockAccess(workingFilePath));

    manager.expectDefinitionRevision(1);
    // No-op: the property already holds this value, so nothing is written.
    await manager.updateWorkingFileProperties({ harness: "claude-cli" });

    const result = await manager.updateWorkingFileProperties({
      model: "sonnet",
    });
    assert.strictEqual(result?.workingFile.model, "sonnet");
  });
});
