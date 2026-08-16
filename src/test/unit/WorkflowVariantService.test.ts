import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, test } from "mocha";
import {
  EXECUTION_STATES,
  HARNESS_IDS,
  type HarnessId,
} from "../../types/DashboardConstants";
import type {
  RunRef,
  WorkflowKey,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import { WorkingFileManager } from "../../core/WorkingFileManager";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import { WorkflowVariantService } from "../../core/orchestration/WorkflowVariantService";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

suite("WorkflowVariantService", () => {
  const workspaces: string[] = [];
  const repository = new WorkflowLineageRepository();

  afterEach(async () => {
    for (const workspace of workspaces.splice(0)) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  async function makeWorkspace(): Promise<string> {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-variant-")
    );
    workspaces.push(workspace);
    return workspace;
  }

  function workingFile(
    workflowName: string,
    prompts: Array<{
      prompt: string;
      harness?: HarnessId;
      _runtime?: Record<string, unknown>;
      status?: string;
      details?: string;
    }>
  ): WorkingFile {
    return {
      workflowName,
      startedAt: 10,
      lastModifiedAt: 11,
      isFavorite: true,
      definitionRevision: 4,
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "source-model",
      steps: prompts,
      _runtime: {
        currentIndex: 1,
        executionState: EXECUTION_STATES.COMPLETED,
      },
    } as WorkingFile;
  }

  async function createDraft(
    workspace: string,
    name: string,
    file: WorkingFile
  ): Promise<WorkflowKey> {
    const created = await repository.createLineage(workspace, name, name);
    await WorkingFileManager.writeWorkingFileAtomic(
      created.draftFilePath,
      file
    );
    return created.workflowKey;
  }

  async function publishRun(
    workspace: string,
    workflowKey: WorkflowKey,
    file: WorkingFile
  ): Promise<RunRef> {
    const allocation = await repository.allocateRun(workspace, workflowKey);
    await WorkingFileManager.writeWorkingFileAtomic(
      allocation.stagingRunFilePath,
      file
    );
    await fs.writeFile(
      path.join(allocation.stagingRunDir, "manifest.json"),
      "{}"
    );
    await fs.writeFile(path.join(allocation.stagingRunDir, "events.jsonl"), "");
    await repository.finalizeAllocatedRun(workspace, workflowKey, allocation);
    return allocation.runRef;
  }

  test("duplicates the exact draft, strips runtime/view fields, and records provenance", async () => {
    const workspace = await makeWorkspace();
    const source = workingFile("Source", [
      {
        prompt: "draft prompt",
        _runtime: { responseText: "old output" },
        status: "completed",
        details: "view only",
      },
    ]);
    const sourceKey = await createDraft(workspace, "Source", source);
    const sourceBytes = await fs.readFile(
      WorkflowPaths.draftFilePath(workspace, sourceKey)
    );
    const sourceDescriptorBytes = await fs.readFile(
      WorkflowPaths.descriptorPath(workspace, sourceKey)
    );

    const address = await new WorkflowVariantService(
      workspace
    ).createWorkflowVariant({
      source: { workflowKey: sourceKey, kind: "draft" },
      workflowName: "Source Copy",
      overrides: {
        harness: HARNESS_IDS.CODEX_CLI,
        model: "variant-model",
      },
    });
    const copied = await WorkingFileManager.readWorkingFileFromDisk(
      WorkflowPaths.draftFilePath(workspace, address.workflowKey)
    );
    const copiedDescriptor = await repository.readDescriptor(
      workspace,
      address.workflowKey
    );

    assert.strictEqual(copied.workflowName, "Source Copy");
    assert.strictEqual(copied.harness, HARNESS_IDS.CODEX_CLI);
    assert.strictEqual(copied.model, "variant-model");
    assert.strictEqual(copied.isFavorite, false);
    assert.deepStrictEqual(copied._runtime, {
      currentIndex: 0,
      executionState: EXECUTION_STATES.IDLE,
    });
    const copiedStep = copied.steps?.[0];
    assert.strictEqual(copiedStep?._runtime, undefined);
    assert.strictEqual(
      copiedStep && "status" in copiedStep ? copiedStep.status : undefined,
      undefined
    );
    assert.strictEqual(
      copiedStep && "details" in copiedStep ? copiedStep.details : undefined,
      undefined
    );
    assert.strictEqual(copiedDescriptor.sourceWorkflowKey, sourceKey);
    assert.strictEqual(copiedDescriptor.sourceRunRef, undefined);
    assert.strictEqual(copiedDescriptor.sourceWorkflowName, "Source");
    assert.strictEqual(typeof copiedDescriptor.variantCreatedAt, "number");
    assert.deepStrictEqual(
      await fs.readFile(WorkflowPaths.draftFilePath(workspace, sourceKey)),
      sourceBytes
    );
    assert.deepStrictEqual(
      await fs.readFile(WorkflowPaths.descriptorPath(workspace, sourceKey)),
      sourceDescriptorBytes
    );
  });

  test("resolves a non-latest run instead of silently using the latest run", async () => {
    const workspace = await makeWorkspace();
    const sourceKey = await createDraft(
      workspace,
      "Source",
      workingFile("Source", [{ prompt: "draft" }])
    );
    const firstRun = await publishRun(
      workspace,
      sourceKey,
      workingFile("Source", [{ prompt: "first run" }])
    );
    const latestRun = await publishRun(
      workspace,
      sourceKey,
      workingFile("Source", [{ prompt: "latest run" }])
    );
    assert.notStrictEqual(firstRun, latestRun);

    const address = await new WorkflowVariantService(
      workspace
    ).createWorkflowVariant({
      source: { workflowKey: sourceKey, kind: "run", runRef: firstRun },
      workflowName: "From First Run",
    });
    const copied = await WorkingFileManager.readWorkingFileFromDisk(
      WorkflowPaths.draftFilePath(workspace, address.workflowKey)
    );
    const descriptor = await repository.readDescriptor(
      workspace,
      address.workflowKey
    );

    assert.strictEqual(
      copied.steps?.[0] && "prompt" in copied.steps[0]
        ? copied.steps[0].prompt
        : undefined,
      "first run"
    );
    assert.strictEqual(descriptor.sourceWorkflowKey, sourceKey);
    assert.strictEqual(descriptor.sourceRunRef, firstRun);
  });

  test("preserves per-step harness pins when overriding the workflow harness", async () => {
    const workspace = await makeWorkspace();
    const sourceKey = await createDraft(
      workspace,
      "Pinned",
      workingFile("Pinned", [
        { prompt: "claude", harness: HARNESS_IDS.CLAUDE_CLI },
        { prompt: "copilot", harness: HARNESS_IDS.COPILOT_CLI },
        { prompt: "antigravity", harness: HARNESS_IDS.ANTIGRAVITY_CLI },
      ])
    );

    const address = await new WorkflowVariantService(
      workspace
    ).createWorkflowVariant({
      source: { workflowKey: sourceKey, kind: "draft" },
      workflowName: "Pinned Copy",
      overrides: { harness: HARNESS_IDS.CODEX_CLI },
    });
    const copied = await WorkingFileManager.readWorkingFileFromDisk(
      WorkflowPaths.draftFilePath(workspace, address.workflowKey)
    );

    assert.strictEqual(copied.harness, HARNESS_IDS.CODEX_CLI);
    assert.deepStrictEqual(
      copied.steps?.map((step) =>
        "harness" in step ? step.harness : undefined
      ),
      [
        HARNESS_IDS.CLAUDE_CLI,
        HARNESS_IDS.COPILOT_CLI,
        HARNESS_IDS.ANTIGRAVITY_CLI,
      ]
    );
  });

  test("rolls back an incomplete lineage when the draft write fails", async () => {
    const workspace = await makeWorkspace();
    const sourceKey = await createDraft(
      workspace,
      "Source",
      workingFile("Source", [{ prompt: "source" }])
    );
    const failingWriter = {
      readWorkingFileFromDisk: WorkingFileManager.readWorkingFileFromDisk,
      writeWorkingFileAtomic: async () => {
        throw new Error("disk full");
      },
    };

    await assert.rejects(
      new WorkflowVariantService(
        workspace,
        repository,
        failingWriter
      ).createWorkflowVariant({
        source: { workflowKey: sourceKey, kind: "draft" },
        workflowName: "Never Written",
      }),
      /disk full/
    );
    assert.deepStrictEqual(await repository.listLineageKeys(workspace), [
      sourceKey,
    ]);
  });

  test("allows duplicate lineages to share a display name", async () => {
    const workspace = await makeWorkspace();
    const sourceKey = await createDraft(
      workspace,
      "Source",
      workingFile("Source", [{ prompt: "source" }])
    );
    const service = new WorkflowVariantService(workspace);
    const first = await service.createWorkflowVariant({
      source: { workflowKey: sourceKey, kind: "draft" },
      workflowName: "Same Name",
    });
    const second = await service.createWorkflowVariant({
      source: { workflowKey: sourceKey, kind: "draft" },
      workflowName: "Same Name",
    });

    assert.notStrictEqual(first.workflowKey, second.workflowKey);
    assert.strictEqual(
      (await repository.readDescriptor(workspace, first.workflowKey))
        .workflowName,
      "Same Name"
    );
    assert.strictEqual(
      (await repository.readDescriptor(workspace, second.workflowKey))
        .workflowName,
      "Same Name"
    );
  });
});
