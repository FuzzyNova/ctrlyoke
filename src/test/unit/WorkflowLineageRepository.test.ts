import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import type { AllocatedRun } from "../../core/orchestration/WorkflowLineageRepository";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

suite("WorkflowLineageRepository", () => {
  const repository = new WorkflowLineageRepository();
  const workspaceRoots: string[] = [];

  async function makeWorkspace(prefix: string): Promise<string> {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    workspaceRoots.push(ws);
    return ws;
  }

  afterEach(async () => {
    for (const ws of workspaceRoots.splice(0)) {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  /** Allocates a run and writes the three required artifacts so it can be finalized. */
  async function publishRun(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<AllocatedRun> {
    const allocation = await repository.allocateRun(workspaceRoot, workflowKey);
    await fs.writeFile(allocation.stagingRunFilePath, "{}");
    await fs.writeFile(
      path.join(allocation.stagingRunDir, "manifest.json"),
      "{}"
    );
    await fs.writeFile(path.join(allocation.stagingRunDir, "events.jsonl"), "");
    await repository.finalizeAllocatedRun(
      workspaceRoot,
      workflowKey,
      allocation
    );
    return allocation;
  }

  suite("createLineage / readDescriptor / tryReadDescriptor", () => {
    test("creates a descriptor and draft dir, and reads it back", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-create-");
      const lineage = await repository.createLineage(
        ws,
        "My Workflow",
        "My Workflow Name"
      );

      assert.ok(lineage.workflowKey.startsWith("my-workflow-"));
      assert.strictEqual(lineage.descriptor.nextRunId, 1);
      assert.strictEqual(lineage.descriptor.revision, 1);
      assert.strictEqual(lineage.descriptor.latestRunRef, undefined);
      await fs.access(WorkflowPaths.draftDir(ws, lineage.workflowKey));

      const read = await repository.readDescriptor(ws, lineage.workflowKey);
      assert.strictEqual(read.workflowName, "My Workflow Name");
    });

    test("carries an optional originalFile through to the descriptor", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-origfile-");
      const lineage = await repository.createLineage(
        ws,
        "hint",
        "Name",
        "source.ctrlyoke.yaml"
      );
      assert.strictEqual(
        lineage.descriptor.originalFile,
        "source.ctrlyoke.yaml"
      );
    });

    test("marks system-generated lineages and reuses an existing key", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-system-");
      const created = await repository.createLineage(
        ws,
        "commit-message-generation",
        "commit-message-generation",
        undefined,
        undefined,
        { isSystemGenerated: true }
      );
      assert.strictEqual(created.descriptor.isSystemGenerated, true);

      const reused = await repository.createLineage(
        ws,
        "commit-message-generation",
        "commit-message-generation",
        undefined,
        undefined,
        { existingWorkflowKey: created.workflowKey }
      );
      assert.strictEqual(reused.workflowKey, created.workflowKey);
      assert.strictEqual(
        reused.draftFilePath,
        WorkflowPaths.draftFilePath(ws, created.workflowKey)
      );
    });

    test("readDescriptor rejects for a missing lineage", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-missing-");
      await assert.rejects(
        repository.readDescriptor(ws, "no-such-workflow" as WorkflowKey)
      );
    });

    test("tryReadDescriptor returns undefined instead of throwing", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-tryread-");
      const result = await repository.tryReadDescriptor(
        ws,
        "no-such-workflow" as WorkflowKey
      );
      assert.strictEqual(result, undefined);
    });
  });

  suite("allocateRun / finalizeAllocatedRun", () => {
    test("marks the first allocated run as isFirstRun with a draft to remove", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-firstrun-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const allocation = await repository.allocateRun(ws, lineage.workflowKey);

      assert.strictEqual(allocation.isFirstRun, true);
      assert.strictEqual(allocation.runId, 1);
      assert.strictEqual(
        allocation.draftFilePathToRemove,
        WorkflowPaths.draftFilePath(ws, lineage.workflowKey)
      );
    });

    test("second allocated run is not first-run and has no draft to remove", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-secondrun-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      await publishRun(ws, lineage.workflowKey);

      const allocation = await repository.allocateRun(ws, lineage.workflowKey);
      assert.strictEqual(allocation.isFirstRun, false);
      assert.strictEqual(allocation.runId, 2);
      assert.strictEqual(allocation.draftFilePathToRemove, undefined);
    });

    test("allocateRun rejects on descriptor revision mismatch", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-revconflict-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      await assert.rejects(
        repository.allocateRun(ws, lineage.workflowKey, 99),
        /Descriptor revision conflict/
      );
    });

    test("finalizeAllocatedRun publishes the run and updates latestRunRef", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-finalize-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const allocation = await publishRun(ws, lineage.workflowKey);

      await fs.access(allocation.runFilePath);
      const descriptor = await repository.readDescriptor(
        ws,
        lineage.workflowKey
      );
      assert.strictEqual(descriptor.latestRunRef, allocation.runRef);
    });

    test("finalizeAllocatedRun rejects when a required artifact is not a plain file", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-missingartifact-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const allocation = await repository.allocateRun(ws, lineage.workflowKey);
      await fs.writeFile(allocation.stagingRunFilePath, "{}");
      // manifest.json is a directory instead of the expected file.
      await fs.mkdir(path.join(allocation.stagingRunDir, "manifest.json"));
      await fs.writeFile(
        path.join(allocation.stagingRunDir, "events.jsonl"),
        ""
      );

      await assert.rejects(
        repository.finalizeAllocatedRun(ws, lineage.workflowKey, allocation),
        /Cannot publish a run without all required artifacts/
      );
    });

    test("finalizeAllocatedRun rejects on descriptor revision conflict", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-finalizeconflict-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const allocation = await repository.allocateRun(ws, lineage.workflowKey);
      await fs.writeFile(allocation.stagingRunFilePath, "{}");
      await fs.writeFile(
        path.join(allocation.stagingRunDir, "manifest.json"),
        "{}"
      );
      await fs.writeFile(
        path.join(allocation.stagingRunDir, "events.jsonl"),
        ""
      );

      // Simulate a concurrent mutation bumping the descriptor's revision first.
      await repository.updateDescriptor(ws, lineage.workflowKey, (d) => ({
        ...d,
        isFavorite: true,
      }));

      await assert.rejects(
        repository.finalizeAllocatedRun(ws, lineage.workflowKey, allocation),
        /Descriptor revision conflict while publishing run/
      );
    });

    test("finalizeAllocatedRun rejects if the target run directory already exists", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-collision-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const allocation = await repository.allocateRun(ws, lineage.workflowKey);
      await fs.writeFile(allocation.stagingRunFilePath, "{}");
      await fs.writeFile(
        path.join(allocation.stagingRunDir, "manifest.json"),
        "{}"
      );
      await fs.writeFile(
        path.join(allocation.stagingRunDir, "events.jsonl"),
        ""
      );

      // Pre-create the public run directory so the publish rename cannot land.
      await fs.mkdir(allocation.runDir, { recursive: true });

      await assert.rejects(
        repository.finalizeAllocatedRun(ws, lineage.workflowKey, allocation)
      );
    });
  });

  suite("deleteRun", () => {
    test("removes the run directory and repairs latestRunRef to the next-newest run", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-delete-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const run1 = await publishRun(ws, lineage.workflowKey);
      const run2 = await publishRun(ws, lineage.workflowKey);

      const result = await repository.deleteRun(
        ws,
        lineage.workflowKey,
        run2.runRef
      );

      assert.deepStrictEqual(result.remainingRunRefs, [run1.runRef]);
      await assert.rejects(fs.access(run2.runDir));
      const descriptor = await repository.readDescriptor(
        ws,
        lineage.workflowKey
      );
      assert.strictEqual(descriptor.latestRunRef, run1.runRef);
      assert.strictEqual(descriptor.revision, result.descriptorRevision);
    });

    test("clears latestRunRef once the last remaining run is deleted", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-deletelast-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const run = await publishRun(ws, lineage.workflowKey);

      const result = await repository.deleteRun(
        ws,
        lineage.workflowKey,
        run.runRef
      );

      assert.deepStrictEqual(result.remainingRunRefs, []);
      const descriptor = await repository.readDescriptor(
        ws,
        lineage.workflowKey
      );
      assert.strictEqual(descriptor.latestRunRef, undefined);
    });

    test("rejects deleting a run that does not exist", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-deletemissing-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      await assert.rejects(
        repository.deleteRun(
          ws,
          lineage.workflowKey,
          "run-2026-01-01T00-00-00-000Z" as RunRef
        ),
        /does not exist/
      );
    });

    test("rejects deleting a run named in the caller-supplied protected set", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-protectedset-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const run = await publishRun(ws, lineage.workflowKey);

      await assert.rejects(
        repository.deleteRun(
          ws,
          lineage.workflowKey,
          run.runRef,
          new Set([run.runRef])
        ),
        /Cannot delete a protected run/
      );
      await fs.access(run.runDir);
    });

    test("rejects deleting a run that is the target of a pending rewind", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-pendingrewind-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const run = await publishRun(ws, lineage.workflowKey);

      await repository.updateDescriptor(ws, lineage.workflowKey, (d) => ({
        ...d,
        pendingEdit: {
          kind: "rewind",
          runRef: run.runRef,
          fromStepIndex: 0,
          baseDefinitionRevision: 1,
        },
      }));

      await assert.rejects(
        repository.deleteRun(ws, lineage.workflowKey, run.runRef),
        /Cannot delete a protected run/
      );
      await fs.access(run.runDir);
    });

    test("rejects deleting a run selected as prior context by another lineage", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-priorcontext-");
      const source = await repository.createLineage(ws, "source", "Source");
      const sourceRun = await publishRun(ws, source.workflowKey);

      const referencer = await repository.createLineage(
        ws,
        "referencer",
        "Referencer"
      );
      await fs.writeFile(
        WorkflowPaths.draftFilePath(ws, referencer.workflowKey),
        JSON.stringify({
          priorContext: {
            workflowKey: source.workflowKey,
            runRef: sourceRun.runRef,
          },
        }),
        "utf8"
      );

      await assert.rejects(
        repository.deleteRun(ws, source.workflowKey, sourceRun.runRef),
        /selected as prior context/
      );
      await fs.access(sourceRun.runDir);
    });
  });

  suite("updateDescriptor", () => {
    test("applies the mutation and bumps revision/lastModifiedAt", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-update-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");

      const updated = await repository.updateDescriptor(
        ws,
        lineage.workflowKey,
        (d) => ({ ...d, isFavorite: true })
      );

      assert.strictEqual(updated.isFavorite, true);
      assert.strictEqual(updated.revision, lineage.descriptor.revision + 1);
      assert.ok(updated.lastModifiedAt >= lineage.descriptor.lastModifiedAt);

      const persisted = await repository.readDescriptor(
        ws,
        lineage.workflowKey
      );
      assert.strictEqual(persisted.isFavorite, true);
    });
  });

  suite("mutateDescriptorAtRevision", () => {
    test("applies the mutation at the expected revision and returns the mutate result", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-matr-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");

      const value = await repository.mutateDescriptorAtRevision(
        ws,
        lineage.workflowKey,
        lineage.descriptor.revision,
        async (descriptor) => ({
          value: "done",
          descriptor: { ...descriptor, isFavorite: true },
        })
      );

      assert.strictEqual(value, "done");
      const read = await repository.readDescriptor(ws, lineage.workflowKey);
      assert.strictEqual(read.isFavorite, true);
      assert.strictEqual(read.revision, lineage.descriptor.revision + 1);
    });

    test("rejects when the expected revision is stale", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-matrconflict-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");

      await assert.rejects(
        repository.mutateDescriptorAtRevision(
          ws,
          lineage.workflowKey,
          lineage.descriptor.revision + 1,
          async (descriptor) => ({ value: undefined, descriptor })
        ),
        /Descriptor revision conflict/
      );
    });
  });

  suite("listLineageKeys", () => {
    test("returns an empty array when no lineages exist yet", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-listempty-");
      const keys = await repository.listLineageKeys(ws);
      assert.deepStrictEqual(keys, []);
    });

    test("lists created lineages and filters out non-lineage entries", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-list-");
      const a = await repository.createLineage(ws, "alpha", "Alpha");
      const b = await repository.createLineage(ws, "beta", "Beta");

      const root = WorkflowPaths.runsRoot(ws);
      await fs.mkdir(path.join(root, ".creating-run-abc"));
      await fs.writeFile(path.join(root, "stray.txt"), "not a lineage");

      const keys = await repository.listLineageKeys(ws);
      assert.deepStrictEqual(
        new Set(keys),
        new Set([a.workflowKey, b.workflowKey])
      );
    });
  });

  suite("pruneStaleStagingDirs", () => {
    test("removes a staging dir whose last write is older than the stale threshold", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-prune-stale-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const staleDir = WorkflowPaths.stagingRunDir(
        ws,
        lineage.workflowKey,
        "orphan"
      );
      await fs.mkdir(staleDir, { recursive: true });
      const old = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(staleDir, old, old);

      await repository.pruneStaleStagingDirs(ws, lineage.workflowKey);

      await assert.rejects(fs.access(staleDir));
    });

    test("leaves a just-created staging dir from an in-flight allocation alone", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-prune-fresh-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const allocation = await repository.allocateRun(ws, lineage.workflowKey);

      await repository.pruneStaleStagingDirs(ws, lineage.workflowKey);

      await fs.access(allocation.stagingRunDir);
    });

    test("does not touch promoted run directories or the draft dir", async () => {
      const ws = await makeWorkspace("ctrlyoke-lineage-prune-safe-");
      const lineage = await repository.createLineage(ws, "wf", "Wf");
      const allocation = await publishRun(ws, lineage.workflowKey);

      await repository.pruneStaleStagingDirs(ws, lineage.workflowKey);

      await fs.access(allocation.runDir);
      await fs.access(WorkflowPaths.draftDir(ws, lineage.workflowKey));
    });
  });
});
