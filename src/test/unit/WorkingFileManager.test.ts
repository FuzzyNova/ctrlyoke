import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { WorkingFileManager } from "../../flightpath/WorkingFileManager";
import type { IWorkingFileQueueAccess } from "../../flightpath/WorkingFileManager";
import type { PromptStep, WorkingFile } from "../../types/FlightPathTypes";
import { EXECUTION_STATES } from "../../types/DashboardConstants";

// ─── Minimal mock for IWorkingFileQueueAccess ────────────────────────────────

function makeMockAccess(workingFilePath?: string): IWorkingFileQueueAccess {
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
    getFinalPromptRuntime: () => undefined,
    updateWorkflowProperty: () => {
      /* no-op */
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
    test("creates file in queueDir and returns a valid path", async () => {
      const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-"));
      tempPaths.push(tmpWorkspace);

      const manager = new WorkingFileManager(makeMockAccess());
      const wfPath = await manager.createWorkingFile(
        "my-workflow",
        [{ prompt: "hello" }],
        tmpWorkspace,
        "my-workflow"
      );
      tempPaths.push(wfPath);

      // File should exist
      await assert.doesNotReject(() => fs.access(wfPath));
      assert.ok(
        wfPath.endsWith(".flightpath.json"),
        `Expected .flightpath.json extension: ${wfPath}`
      );
    });

    test("created file is valid JSON with expected workflow name", async () => {
      const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-"));
      tempPaths.push(tmpWorkspace);

      const manager = new WorkingFileManager(makeMockAccess());
      const wfPath = await manager.createWorkingFile(
        "test-run",
        [{ prompt: "step" }],
        tmpWorkspace,
        "test-workflow"
      );
      tempPaths.push(wfPath);

      const content = await fs.readFile(wfPath, "utf-8");
      const parsed = JSON.parse(content) as WorkingFile;
      assert.strictEqual(parsed.workflowName, "test-workflow");
      assert.strictEqual(parsed.steps!.length, 1);
    });

    test("filename is sanitized — spaces and special chars replaced with hyphens", async () => {
      const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-"));
      tempPaths.push(tmpWorkspace);

      const manager = new WorkingFileManager(makeMockAccess());
      const wfPath = await manager.createWorkingFile(
        "My Workflow! With Spaces",
        [],
        tmpWorkspace,
        "My Workflow"
      );
      tempPaths.push(wfPath);

      const fileName = path.basename(wfPath);
      assert.ok(
        !/\s/.test(fileName),
        `Filename should not contain whitespace: ${fileName}`
      );
      assert.ok(
        !/[!]/.test(fileName),
        `Filename should not contain special chars: ${fileName}`
      );
    });

    test("filename includes a timestamp segment", async () => {
      const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "fp-ws-"));
      tempPaths.push(tmpWorkspace);

      const manager = new WorkingFileManager(makeMockAccess());
      const wfPath = await manager.createWorkingFile(
        "timestamped",
        [],
        tmpWorkspace,
        "Timestamped"
      );
      tempPaths.push(wfPath);

      const fileName = path.basename(wfPath);
      // Format: <sanitized-name>-YYYY-MM-DDTHH-MM-SS.flightpath.json
      assert.ok(
        /\d{4}-\d{2}-\d{2}T/.test(fileName),
        `Expected timestamp in filename: ${fileName}`
      );
    });
  });
});
