import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import { RunBundleImporter } from "../../core/orchestration/RunBundleImporter";
import { exportRunBundle } from "../../core/orchestration/RunBundleExporter";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { TimelineRecorder } from "../../core/orchestration/TimelineRecorder";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import type { WorkingFile } from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import { HistorySearchService } from "../../core/orchestration/HistorySearchService";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

suite("RunBundleImporter", () => {
  let root: string;
  let workspace: string;
  let bundle: string;
  let importer: RunBundleImporter;

  setup(async () => {
    root = makeTempDir("ctrlyoke-run-import-");
    workspace = path.join(root, "workspace");
    bundle = path.join(root, "fixture.ctrlyokerun");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(bundle, { recursive: true });
    importer = new RunBundleImporter();
    await writeFixtureBundle(bundle);
  });

  teardown(() => removeTempDir(root));

  test("imports ordered events with fresh identity and a trusted anchored definition", async () => {
    const result = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: bundle,
    });
    assert.strictEqual(result.status, "imported");
    if (result.status !== "imported") return;
    const manifestPath = WorkflowPaths.manifestPath(
      workspace,
      result.workflowKey as never,
      result.runRef as never
    );
    const timeline = new TimelineRecorder();
    const manifest = await timeline.readManifest(manifestPath);
    const events = await timeline.readEvents(manifestPath);
    const payloads = events
      .slice(0, 2)
      .map(
        (event) =>
          event.payload as unknown as { cliOutput: { cliCommand?: string } }
      );
    assert.deepStrictEqual(
      payloads.map((payload) => payload.cliOutput.cliCommand),
      ["bundlefixture first", "bundlefixture second"]
    );
    assert.notStrictEqual(manifest.workflowId, "source-workflow");
    assert.notStrictEqual(manifest.runId, 41);
    assert.strictEqual(events[0].sequence, 17);
    assert.ok(
      events.every(
        (event) =>
          event.workflowId === manifest.workflowId &&
          event.runId === manifest.runId
      )
    );
    const runFile = WorkflowPaths.runFilePath(
      workspace,
      result.workflowKey as never,
      result.runRef as never
    );
    assert.strictEqual(
      (await WorkingFileManager.inspectDefinitionIntegrity(runFile)).status,
      "trusted"
    );
    assert.strictEqual(manifest.executionState, "completed");
    const search = new HistorySearchService();
    await search.enqueueWorkspaceRefresh(workspace);
    assert.ok(
      (await search.search("bundlefixture", workspace)).results.length > 0
    );
  });

  test("round-trips an exported fixture run through the importer", async () => {
    const sourceWorkspace = path.join(root, "source");
    await fs.mkdir(sourceWorkspace, { recursive: true });
    const repository = new WorkflowLineageRepository();
    const lineage = await repository.createLineage(
      sourceWorkspace,
      "fixture-source",
      "Fixture source"
    );
    const allocation = await repository.allocateRun(
      sourceWorkspace,
      lineage.workflowKey
    );
    const workingFile = {
      steps: [{ prompt: "exported fixture" }],
      startedAt: 100,
      definitionRevision: 1,
      _runtime: {
        currentIndex: 1,
        executionState: EXECUTION_STATES.COMPLETED,
        executionEndTime: 200,
      },
    } as WorkingFile;
    await WorkingFileManager.writeWorkingFileAtomic(
      allocation.stagingRunFilePath,
      workingFile
    );
    const timeline = new TimelineRecorder();
    const manifestPath = await timeline.initializeRunAt(
      allocation.stagingRunDir,
      lineage.workflowKey,
      allocation.runId,
      100,
      EXECUTION_STATES.RUNNING
    );
    await timeline.appendEvents(manifestPath, [
      {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: 150,
        target: { kind: "queue", stepIndex: 0 },
        attemptIndex: 0,
        definitionRevision: 1,
        payload: {
          cliOutput: {
            cliCommand: "roundtrip marker",
            elapsed: 1,
            isStreaming: false,
            workingDirectory: sourceWorkspace,
          },
        },
      },
    ]);
    await timeline.updateManifest(manifestPath, (manifest) => ({
      ...manifest,
      completedAt: 200,
      executionState: EXECUTION_STATES.COMPLETED,
      stepCount: 1,
    }));
    await WorkingFileManager.publishAnchoredRun(
      sourceWorkspace,
      lineage.workflowKey,
      allocation,
      workingFile,
      repository
    );
    const exported = await exportRunBundle({
      stateRoot: sourceWorkspace,
      workspaceRoot: sourceWorkspace,
      workflowKey: lineage.workflowKey,
      runRef: allocation.runRef,
      bundleDir: path.join(root, "roundtrip.ctrlyokerun"),
      exportedByVersion: "test",
      homeDir: root,
    });
    const imported = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: exported.bundleDir,
    });
    assert.strictEqual(imported.status, "imported");
  });

  test("recomputes output workingDirectory and detects a repeated bundle", async () => {
    const first = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: bundle,
    });
    assert.strictEqual(first.status, "imported");
    if (first.status !== "imported") return;
    const manifestPath = WorkflowPaths.manifestPath(
      workspace,
      first.workflowKey as never,
      first.runRef as never
    );
    const events = await new TimelineRecorder().readEvents(manifestPath);
    assert.ok(
      events.slice(0, 2).every(
        (event) =>
          (
            event.payload as unknown as {
              cliOutput: { workingDirectory?: string };
            }
          ).cliOutput.workingDirectory === workspace
      )
    );
    assert.deepStrictEqual(
      await importer.importRun({ workspaceRoot: workspace, bundleDir: bundle }),
      {
        status: "alreadyImported",
        workflowKey: first.workflowKey,
      }
    );
    assert.strictEqual(
      (
        await importer.importRun({
          workspaceRoot: workspace,
          bundleDir: bundle,
          again: true,
        })
      ).status,
      "imported"
    );
  });

  test("rejects total-byte cap and tampered assets before allocating a lineage", async () => {
    await assert.rejects(
      importer.importRun({
        workspaceRoot: workspace,
        bundleDir: bundle,
        maxTotalBytes: 1,
      }),
      /total size limit/
    );
    await assert.rejects(
      importer.importRun({
        workspaceRoot: workspace,
        bundleDir: bundle,
        maxEventCount: 1,
      }),
      /event limit/
    );
    const before = await new WorkflowLineageRepository().listLineageKeys(
      workspace
    );
    await fs.mkdir(path.join(bundle, "assets"), { recursive: true });
    await fs.writeFile(path.join(bundle, "assets", "payload.txt"), "tampered");
    const manifestPath = path.join(bundle, "run.json");
    const run = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      assets?: unknown[];
    };
    run.assets = [
      { path: "assets/payload.txt", bytes: 8, sha256: "0".repeat(64) },
    ];
    await fs.writeFile(manifestPath, JSON.stringify(run));
    await assert.rejects(
      importer.importRun({ workspaceRoot: workspace, bundleDir: bundle }),
      /SHA-256 check/
    );
    assert.deepStrictEqual(
      await new WorkflowLineageRepository().listLineageKeys(workspace),
      before
    );
  });
});

async function writeFixtureBundle(bundle: string): Promise<void> {
  await fs.writeFile(
    path.join(bundle, "run.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "ctrlyoke.run.bundle",
      exportedAt: "2026-10-31T12:00:00.000Z",
      exportedByVersion: "0.4.1",
      sourceRoot: "${workspaceFolder}/source",
      lineage: { workflowName: "Imported fixture" },
      provenance: {
        workflowKey: "source-workflow",
        runRef: "run-2026-10-31T12-00-00-000Z",
        runId: 41,
        steps: [],
      },
      includesSnapshots: false,
      redaction: { policy: "secrets-v1", removedCount: 0, byRule: {} },
      externalPaths: [],
    })
  );
  await fs.writeFile(
    path.join(bundle, "workflow.ctrlyoke.json"),
    JSON.stringify({
      steps: [{ prompt: "fixture" }],
    })
  );
  await fs.writeFile(
    path.join(bundle, "manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      storageKind: "timeline",
      runId: 41,
      startedAt: 100,
      completedAt: 200,
      executionState: "completed",
      definitionRevision: 1,
      stepCount: 1,
      eventCount: 2,
      nextSequence: 17,
      lastUpdatedAt: 200,
    })
  );
  await fs.writeFile(
    path.join(bundle, "events.jsonl"),
    ["first", "second"]
      .map((message, index) =>
        JSON.stringify({
          eventType: "cliOutputRecorded",
          timestampMs: 150 + index,
          sequence: index + 1,
          target: { stepIndex: 0 },
          attemptIndex: 0,
          definitionRevision: 1,
          payload: {
            cliOutput: {
              cliCommand: `bundlefixture ${message}`,
              elapsed: 1,
              isStreaming: false,
              workingDirectory: "C:/hostile",
            },
          },
        })
      )
      .join("\n") + "\n"
  );
}
