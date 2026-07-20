import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import type { IWorkingFileQueueAccess } from "../../core/WorkingFileManager";
import type { PromptStep, WorkingFile } from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../../types/DashboardConstants";

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
});
