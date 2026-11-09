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
import { execGit } from "../../utils/GitUtils";
import { RunOutputResolver } from "../../core/orchestration/RunOutputResolver";
import { RunContinuationService } from "../../core/orchestration/RunContinuationService";
import {
  RunMaterializer,
  type RunMaterializationInput,
} from "../../core/orchestration/RunMaterializer";
import { parseAtReferences } from "../../utils/FileReferenceParser";
import { resolveReferencePath } from "../../platform/WorkspaceRootResolver";

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
    assert.deepStrictEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4]
    );
    assert.strictEqual(events[3].eventType, TIMELINE_EVENT_TYPES.RUN_IMPORTED);
    const importedDescriptor =
      await new WorkflowLineageRepository().readDescriptor(
        workspace,
        result.workflowKey
      );
    assert.strictEqual(importedDescriptor.importedFrom?.kind, "runBundle");
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

  test("rebuilds history-only step runtime from the latest attempts", async () => {
    await fs.writeFile(
      path.join(bundle, "workflow.ctrlyoke.json"),
      JSON.stringify({
        steps: [{ prompt: "one" }, { prompt: "rerun" }, { prompt: "not run" }],
      })
    );
    const attempt = (
      stepIndex: number,
      attemptIndex: number,
      started: number,
      terminal?: string
    ) => [
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: started,
        target: { kind: "queue", stepIndex },
        runIndex: 0,
        attemptIndex,
        definitionRevision: 1,
        payload: {
          kind: "script",
          startReason: attemptIndex ? "retry" : "initial",
          prompt: "run",
        },
      },
      ...(terminal
        ? [
            {
              eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
              timestampMs: started + 10,
              target: { kind: "queue", stepIndex },
              runIndex: 0,
              attemptIndex,
              definitionRevision: 1,
              payload: { terminalState: terminal },
            },
          ]
        : []),
    ];
    await fs.writeFile(
      path.join(bundle, "events.jsonl"),
      [
        ...attempt(0, 0, 100, "completed"),
        ...attempt(1, 0, 110, "failed"),
        ...attempt(1, 1, 130, "completed"),
      ]
        .map((event, index) =>
          JSON.stringify({ ...event, sequence: index + 1 })
        )
        .join("\n") + "\n"
    );
    const result = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: bundle,
    });
    assert.strictEqual(result.status, "imported");
    if (result.status !== "imported") return;
    const runFile = JSON.parse(
      await fs.readFile(
        WorkflowPaths.runFilePath(workspace, result.workflowKey, result.runRef),
        "utf8"
      )
    ) as WorkingFile;
    assert.strictEqual(
      runFile.steps?.[0]._runtime?.terminalStatus,
      "completed"
    );
    assert.strictEqual(runFile.steps?.[0]._runtime?.startedAt, 100);
    assert.strictEqual(runFile.steps?.[0]._runtime?.completedAt, 110);
    assert.strictEqual(
      runFile.steps?.[1]._runtime?.terminalStatus,
      "completed"
    );
    assert.strictEqual(runFile.steps?.[1]._runtime?.startedAt, 130);
    assert.strictEqual(runFile.steps?.[1]._runtime?.completedAt, 140);
    assert.strictEqual(runFile.steps?.[2]._runtime, undefined);
  });

  test("preserves an existing terminal event and active duration when importing", async () => {
    const completedAt = 200;
    const activeExecutionMs = 115;
    const manifestPath = path.join(bundle, "manifest.json");
    const sourceManifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8")
    ) as Record<string, unknown>;
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...sourceManifest, completedAt, activeExecutionMs })
    );
    const eventsPath = path.join(bundle, "events.jsonl");
    const existingEvents = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n");
    existingEvents.push(
      JSON.stringify({
        eventType: TIMELINE_EVENT_TYPES.RUN_TERMINATED,
        timestampMs: completedAt,
        sequence: 9,
        payload: { executionState: EXECUTION_STATES.COMPLETED, stepCount: 1 },
      })
    );
    await fs.writeFile(eventsPath, `${existingEvents.join("\n")}\n`);

    const result = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: bundle,
    });
    assert.strictEqual(result.status, "imported");
    if (result.status !== "imported") return;
    const importedManifestPath = WorkflowPaths.manifestPath(
      workspace,
      result.workflowKey,
      result.runRef
    );
    const timeline = new TimelineRecorder();
    const importedManifest = await timeline.readManifest(importedManifestPath);
    const importedEvents = await timeline.readEvents(importedManifestPath);
    assert.strictEqual(
      importedEvents.filter(
        (event) => event.eventType === TIMELINE_EVENT_TYPES.RUN_TERMINATED
      ).length,
      1
    );
    assert.strictEqual(importedManifest.completedAt, completedAt);
    assert.strictEqual(importedManifest.activeExecutionMs, activeExecutionMs);
    assert.strictEqual(
      importedEvents.at(-1)?.eventType,
      TIMELINE_EVENT_TYPES.RUN_IMPORTED
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
        importedFrom: {
          provenance: {
            workflowKey: "source-workflow" as never,
            runRef: "source-run" as never,
            runId: 7,
            steps: [],
          },
          exportedAt: "2026-10-31T12:00:00.000Z",
          exportedByVersion: "0.4.1",
          sourceRoot: "${workspaceFolder}/original",
        },
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
    const sourceAttempt = await new RunOutputResolver().resolveAttempt(
      WorkflowPaths.manifestPath(
        sourceWorkspace,
        lineage.workflowKey,
        allocation.runRef
      ),
      { kind: "queue", stepIndex: 0 },
      0,
      0
    );
    const exportedBundle = JSON.parse(
      await fs.readFile(path.join(exported.bundleDir, "run.json"), "utf8")
    ) as { importedFrom: unknown };
    assert.deepStrictEqual(
      exportedBundle.importedFrom,
      workingFile._runtime?.importedFrom
    );
    const imported = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: exported.bundleDir,
    });
    assert.strictEqual(imported.status, "imported");
    if (imported.status !== "imported") return;
    const importedAttempt = await new RunOutputResolver().resolveAttempt(
      WorkflowPaths.manifestPath(
        workspace,
        imported.workflowKey as never,
        imported.runRef as never
      ),
      { kind: "queue", stepIndex: 0 },
      0,
      0
    );
    assert.deepStrictEqual(
      importedAttempt?.output?.structured?.events,
      sourceAttempt?.output?.structured?.events
    );
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
    assert.strictEqual(
      events.at(-1)?.eventType,
      TIMELINE_EVENT_TYPES.RUN_IMPORTED
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

  test("round-trips a stopped working file and preserves its continuation position", async () => {
    await makeContinuableBundle();
    const result = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: bundle,
      changes: "skip",
    });
    assert.strictEqual(result.status, "imported");
    if (result.status !== "imported") return;
    assert.strictEqual(result.placement?.target, "skip");
    const runFile = JSON.parse(
      await fs.readFile(
        WorkflowPaths.runFilePath(workspace, result.workflowKey, result.runRef),
        "utf8"
      )
    ) as {
      steps: Array<{ _runtime?: Record<string, unknown> }>;
      finalStep?: { prompt?: string; _runtime?: Record<string, unknown> };
      _runtime: Record<string, unknown>;
    };
    assert.strictEqual(runFile._runtime.executionState, "stopped");
    assert.strictEqual(runFile._runtime.currentIndex, 2);
    assert.strictEqual(runFile._runtime.startTime, 100);
    assert.strictEqual(runFile._runtime.totalPausedDuration, 15);
    assert.deepStrictEqual(runFile.steps[0]._runtime, {
      sessionId: "session-0",
      completedAt: 110,
    });
    assert.deepStrictEqual(runFile.steps[1]._runtime, {
      sessionId: "session-1",
      completedAt: 120,
    });
    assert.deepStrictEqual(runFile.finalStep?._runtime, {
      sessionId: "final-session",
    });
    assert.deepStrictEqual(runFile._runtime.finalStep, {
      phase: "idle",
      loopCount: 0,
    });
    assert.strictEqual(runFile.finalStep?.prompt, "final authored prompt");
    assert.strictEqual("worktree" in runFile._runtime, false);
    assert.strictEqual("stopReason" in runFile._runtime, false);
    assert.strictEqual("worktreeNotice" in runFile._runtime, false);
    assert.strictEqual("pendingRewind" in runFile._runtime, false);
    assert.ok(runFile._runtime.importedFrom);
    assert.strictEqual(
      (
        await RunContinuationService.validateContinuationTarget(
          workspace,
          result.workflowKey,
          result.runRef
        )
      ).allowInterruptedRun,
      false
    );
    const events = await new TimelineRecorder().readEvents(
      WorkflowPaths.manifestPath(workspace, result.workflowKey, result.runRef)
    );
    assert.strictEqual(
      (events[0].payload as { cliOutput: { workingDirectory: string } })
        .cliOutput.workingDirectory,
      workspace
    );
  });

  test("rewrites exported attachment references in continuation prompts", async () => {
    await makeContinuableBundle(undefined, true);
    await fs.rm(path.join(workspace, ".ctrlyoke", "attachments", "note.md"));
    const result = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: bundle,
      changes: "skip",
    });
    assert.strictEqual(result.status, "imported");
    if (result.status !== "imported") return;
    const runFilePath = WorkflowPaths.runFilePath(
      workspace,
      result.workflowKey,
      result.runRef
    );
    const runFile = JSON.parse(await fs.readFile(runFilePath, "utf8")) as {
      steps: Array<{ prompt: string }>;
    };
    const prompt = runFile.steps[2].prompt;
    assert.match(prompt, /assets\/app\.css/);
    const reference = parseAtReferences(prompt).find((item) =>
      item.path.includes("note.md")
    );
    assert.ok(reference, "pending step should retain its attachment reference");
    const resolved = resolveReferencePath(reference!.path, {
      primaryRoot: workspace,
      namedRoots: [],
    }).absolutePath;
    assert.strictEqual(
      resolved,
      path.join(workspace, ".ctrlyoke", "attachments", "note.md")
    );
    assert.strictEqual(
      await fs.readFile(resolved, "utf8"),
      "shared attachment\n"
    );
  });

  test("removes newly copied assets when materialization fails", async () => {
    await makeContinuableBundle(undefined, true);
    await fs.rm(path.join(workspace, ".ctrlyoke", "attachments", "note.md"));
    const failingImporter = new RunBundleImporter(new FailingRunMaterializer());
    await assert.rejects(
      failingImporter.importRun({
        workspaceRoot: workspace,
        bundleDir: bundle,
      }),
      /simulated materialization failure/
    );
    await assert.rejects(
      fs.access(path.join(workspace, ".ctrlyoke", "attachments", "note.md")),
      { code: "ENOENT" }
    );
  });

  test("rolls back checkout placement when event materialization fails", async () => {
    const baseCommit = await makeContinuableBundle();
    await execGit(["reset", "--hard", baseCommit], { cwd: workspace });
    await assert.rejects(
      new RunBundleImporter(
        new FailingAfterPlacementRunMaterializer()
      ).importRun({
        workspaceRoot: workspace,
        bundleDir: bundle,
        changes: "checkout",
      }),
      /simulated post-placement failure/
    );
    assert.strictEqual(
      (
        await execGit(["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: workspace,
        })
      ).stdout.trim(),
      ""
    );
    assert.strictEqual(
      (await fs.readFile(path.join(workspace, "tracked.txt"), "utf8")).replace(
        /\r\n/g,
        "\n"
      ),
      "base\n"
    );
    assert.strictEqual(
      (await execGit(["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim(),
      baseCommit
    );
  });

  test("removes a managed worktree when event materialization fails", async () => {
    const baseCommit = await makeContinuableBundle();
    await execGit(["reset", "--hard", baseCommit], { cwd: workspace });
    await assert.rejects(
      new RunBundleImporter(
        new FailingAfterPlacementRunMaterializer()
      ).importRun({
        workspaceRoot: workspace,
        bundleDir: bundle,
        changes: "worktree",
      }),
      /simulated post-placement failure/
    );
    const worktrees = (
      await execGit(["worktree", "list", "--porcelain"], { cwd: workspace })
    ).stdout;
    assert.strictEqual((worktrees.match(/^worktree /gm) ?? []).length, 1);
  });

  test("missing base commit imports history only", async () => {
    await makeContinuableBundle("f".repeat(40));
    const result = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: bundle,
      changes: "checkout",
    });
    assert.strictEqual(result.status, "imported");
    if (result.status !== "imported") return;
    assert.strictEqual(result.placement?.applied, false);
    assert.match(result.placement?.warning ?? "", /push\/fetch commit/);
    const runFile = JSON.parse(
      await fs.readFile(
        WorkflowPaths.runFilePath(workspace, result.workflowKey, result.runRef),
        "utf8"
      )
    ) as { _runtime: Record<string, unknown> };
    assert.match(
      (runFile._runtime.importedFrom as { viewOnly: { reason: string } })
        .viewOnly.reason,
      /Base commit .* unavailable/
    );
    await assert.rejects(
      RunContinuationService.validateContinuationTarget(
        workspace,
        result.workflowKey,
        result.runRef
      ),
      /This run was imported view-only:.*Base commit .* unavailable/
    );
  });

  test("history-only imports cannot be continued", async () => {
    const result = await importer.importRun({
      workspaceRoot: workspace,
      bundleDir: bundle,
    });
    assert.strictEqual(result.status, "imported");
    if (result.status !== "imported") return;
    await assert.rejects(
      RunContinuationService.validateContinuationTarget(
        workspace,
        result.workflowKey,
        result.runRef
      ),
      /This run was imported view-only: this bundle contains history only/
    );
  });

  async function makeContinuableBundle(
    missingBase?: string,
    withAttachment = false
  ): Promise<string> {
    await execGit(["init"], { cwd: workspace });
    await execGit(["config", "user.email", "test@example.com"], {
      cwd: workspace,
    });
    await execGit(["config", "user.name", "Test"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "tracked.txt"), "base\n");
    await execGit(["add", "tracked.txt"], { cwd: workspace });
    await execGit(["commit", "-m", "base"], { cwd: workspace });
    const baseCommit = (
      await execGit(["rev-parse", "HEAD"], { cwd: workspace })
    ).stdout.trim();
    await fs.writeFile(path.join(workspace, "tracked.txt"), "changed\n");
    if (withAttachment) {
      await fs.mkdir(path.join(workspace, ".ctrlyoke", "attachments"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(workspace, ".ctrlyoke", "attachments", "note.md"),
        "shared attachment\n"
      );
    }
    const repository = new WorkflowLineageRepository();
    const lineage = await repository.createLineage(
      workspace,
      "continuable fixture",
      "Continuable fixture"
    );
    const allocation = await repository.allocateRun(
      workspace,
      lineage.workflowKey
    );
    const workingFile = {
      steps: [
        {
          prompt: "step 0",
          _runtime: { sessionId: "session-0", completedAt: 110 },
        },
        {
          prompt: "step 1",
          _runtime: { sessionId: "session-1", completedAt: 120 },
        },
        {
          prompt: withAttachment
            ? "Read @.ctrlyoke/attachments/note.md; keep assets/app.css unchanged."
            : "step 2",
        },
        { prompt: "step 3" },
      ],
      finalStep: {
        prompt: "final authored prompt",
        _runtime: { sessionId: "final-session" },
      },
      startedAt: 100,
      definitionRevision: 1,
      _runtime: {
        currentIndex: 2,
        executionState: EXECUTION_STATES.STOPPED,
        startTime: 100,
        totalPausedDuration: 15,
        executionEndTime: 200,
        stopReason: { reason: "old" },
        finalStep: { phase: "idle", loopCount: 0 },
      },
    } as unknown as WorkingFile;
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
      EXECUTION_STATES.STOPPED
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
            cliCommand: "continuable fixture output",
            elapsed: 1,
            isStreaming: false,
            workingDirectory: workspace,
          },
        },
      },
    ]);
    await timeline.updateManifest(manifestPath, (manifest) => ({
      ...manifest,
      completedAt: 200,
      executionState: EXECUTION_STATES.STOPPED,
      stepCount: 4,
    }));
    await WorkingFileManager.publishAnchoredRun(
      workspace,
      lineage.workflowKey,
      allocation,
      workingFile,
      repository
    );
    const exported = await exportRunBundle({
      stateRoot: workspace,
      workspaceRoot: workspace,
      workflowKey: lineage.workflowKey,
      runRef: allocation.runRef,
      bundleDir: bundle,
      exportedByVersion: "test",
      homeDir: root,
      replace: true,
    });
    assert.strictEqual(exported.continuable, true);
    const runtimePath = path.join(bundle, "run.ctrlyoke.json");
    const exportedRuntime = JSON.parse(
      await fs.readFile(runtimePath, "utf8")
    ) as { _runtime: Record<string, unknown> };
    Object.assign(exportedRuntime._runtime, {
      worktree: { worktreePath: "C:/source/worktree" },
      worktreeNotice: "old location",
      pendingRewind: { fromStepIndex: 1, baseDefinitionRevision: 1 },
    });
    await fs.writeFile(runtimePath, JSON.stringify(exportedRuntime));
    if (missingBase) {
      const bundleManifest = JSON.parse(
        await fs.readFile(path.join(bundle, "run.json"), "utf8")
      ) as { continuation: { workspace: { baseCommit: string } } };
      bundleManifest.continuation.workspace.baseCommit = missingBase;
      await fs.writeFile(
        path.join(bundle, "run.json"),
        JSON.stringify(bundleManifest)
      );
    }
    return baseCommit;
  }
});

class FailingRunMaterializer extends RunMaterializer {
  override async materialize(_input: RunMaterializationInput): Promise<never> {
    throw new Error("simulated materialization failure");
  }
}

class FailingAfterPlacementRunMaterializer extends RunMaterializer {
  override async materialize(input: RunMaterializationInput) {
    async function* failAfterPlacement(): AsyncGenerator<never> {
      throw new Error("simulated post-placement failure");
    }
    return super.materialize({ ...input, events: failAfterPlacement() });
  }
}

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
          sequence: index === 0 ? 1 : 8,
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
