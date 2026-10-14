import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { AddressedPriorContextResolver } from "../../core/orchestration/AddressedPriorContextResolver";
import { RunOutputResolver } from "../../core/orchestration/RunOutputResolver";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type {
  PriorContextRunSource,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import {
  TIMELINE_SCHEMA_VERSION,
  TIMELINE_STORAGE_KIND,
} from "../../types/WorkflowTimelineTypes";

suite("AddressedPriorContextResolver", () => {
  let workspaceRoot: string;
  const workflowKey = "source-2026-07-20T00-00-00" as WorkflowKey;
  const olderRunRef = "run-2026-07-20T00-00-00-000Z" as RunRef;
  const newerRunRef = "run-2026-07-21T00-00-00-000Z" as RunRef;
  /** Each run's manifest fields; the newer run is still executing. */
  const manifests = new Map<string, { runId: number; completedAt?: number }>([
    [olderRunRef, { runId: 1, completedAt: 1 }],
    [newerRunRef, { runId: 2 }],
  ]);

  async function writeDescriptor(
    key: WorkflowKey,
    workflowName: string
  ): Promise<void> {
    await fs.mkdir(WorkflowPaths.lineageDir(workspaceRoot, key), {
      recursive: true,
    });
    await fs.writeFile(
      WorkflowPaths.descriptorPath(workspaceRoot, key),
      JSON.stringify({
        schemaVersion: 1,
        workflowKey: key,
        workflowName,
        isFavorite: false,
        createdAt: 1,
        lastModifiedAt: 1,
        nextRunId: 3,
        revision: 1,
      })
    );
  }

  /** Records which source run was imported, by its manifest path. */
  function createOutputResolver(imported: string[] = []): RunOutputResolver {
    return {
      getManifest: async (manifestPath: string) => {
        const runRef = path.basename(path.dirname(manifestPath));
        const manifest = manifests.get(runRef);
        if (!manifest) throw new Error("missing");
        return manifest;
      },
      resolveAllPriorContextItems: async (manifestPath: string) => {
        imported.push(path.basename(path.dirname(manifestPath)));
        return [
          { index: 0, prompt: "source", text: "source output", detail: "full" },
        ];
      },
    } as unknown as RunOutputResolver;
  }

  async function importedRun(
    source: PriorContextRunSource
  ): Promise<string | undefined> {
    const imported: string[] = [];
    await new AddressedPriorContextResolver(
      workspaceRoot,
      createOutputResolver(imported)
    ).resolve([source], async () => []);
    return imported[0];
  }

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-context-"));
    for (const runRef of [olderRunRef, newerRunRef]) {
      await fs.mkdir(WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef), {
        recursive: true,
      });
    }
    await writeDescriptor(workflowKey, "Bug Sweep");
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("keeps same-run defaults and imports the source with its detail", async () => {
    let addressedDetail: string | undefined;
    const resolver = {
      getManifest: createOutputResolver().getManifest,
      resolveAllPriorContextItems: async (
        _manifest: string,
        _options: unknown,
        detail: string
      ) => {
        addressedDetail = detail;
        return [
          { index: 0, prompt: "source", text: "source output", detail: "full" },
        ];
      },
    } as unknown as RunOutputResolver;
    const result = await new AddressedPriorContextResolver(
      workspaceRoot,
      resolver
    ).resolve(
      [
        "previous",
        { context: { workflow: workflowKey, run: 1 }, detail: "summary" },
      ],
      async (local) => {
        assert.deepStrictEqual(local, ["previous"]);
        return [
          { index: 0, prompt: "local", text: "local output", detail: "full" },
        ];
      }
    );

    assert.deepStrictEqual(
      result.map((item) => item.text),
      ["local output", "source output"]
    );
    assert.strictEqual(addressedDetail, "summary");
  });

  test("routes { previous: N } to the same run instead of treating it as a source", async () => {
    const resolver = {
      getManifest: async () => {
        throw new Error("a relative selector must never be resolved as a run");
      },
      resolveAllPriorContextItems: async () => [],
    } as unknown as RunOutputResolver;
    const result = await new AddressedPriorContextResolver(
      workspaceRoot,
      resolver
    ).resolve([{ previous: 3 }], async (local) => {
      assert.deepStrictEqual(local, [{ previous: 3 }]);
      return [
        { index: 0, prompt: "local", text: "local output", detail: "full" },
      ];
    });

    assert.deepStrictEqual(
      result.map((item) => item.text),
      ["local output"]
    );
  });

  test("selects the workflow by key, name, or slug, and the run by number or reference", async () => {
    assert.strictEqual(
      await importedRun({ workflow: workflowKey, run: 1 }),
      olderRunRef
    );
    assert.strictEqual(
      await importedRun({ workflow: "bug sweep", run: olderRunRef }),
      olderRunRef
    );
    assert.strictEqual(
      await importedRun({ workflow: "SOURCE", run: 1 }),
      olderRunRef
    );
  });

  test("uses the latest completed run when run is omitted", async () => {
    assert.strictEqual(
      await importedRun({ workflow: "Bug Sweep" }),
      olderRunRef
    );
  });

  test("reports unknown, ambiguous, and missing selectors by name only", async () => {
    await assert.rejects(
      () => importedRun({ workflow: "nothing" }),
      /workflow "nothing" was not found/
    );
    await assert.rejects(
      () => importedRun({ workflow: workflowKey, run: 9 }),
      /run 9 was not found/
    );

    const twin = "bug-sweep-2026-07-22T00-00-00" as WorkflowKey;
    await writeDescriptor(twin, "Bug Sweep");
    await assert.rejects(
      () => importedRun({ workflow: "Bug Sweep" }),
      (error: Error) =>
        error.message.includes("matches more than one workflow") &&
        error.message.includes(twin) &&
        !error.message.includes(workspaceRoot)
    );
  });

  test("rejects a nonterminal source run without path leakage", async () => {
    await assert.rejects(
      () => importedRun({ workflow: workflowKey, run: 2 }),
      (error: Error) =>
        /unavailable, deleted, or not yet complete/.test(error.message) &&
        !error.message.includes(workspaceRoot)
    );
  });

  suite("deletion protection", () => {
    async function writeConsumer(source: PriorContextRunSource): Promise<void> {
      const repository = new WorkflowLineageRepository();
      const lineage = await repository.createLineage(
        workspaceRoot,
        "consumer",
        "consumer"
      );
      await fs.writeFile(
        lineage.draftFilePath,
        JSON.stringify({
          steps: [{ prompt: "use source", priorContext: source }],
        })
      );
      await fs.writeFile(
        WorkflowPaths.manifestPath(workspaceRoot, workflowKey, olderRunRef),
        JSON.stringify({
          schemaVersion: TIMELINE_SCHEMA_VERSION,
          storageKind: TIMELINE_STORAGE_KIND,
          workflowId: workflowKey,
          runId: 1,
          startedAt: 1,
          completedAt: 1,
          executionState: "completed",
          definitionRevision: 1,
          stepCount: 0,
          eventCount: 0,
          nextSequence: 1,
          lastUpdatedAt: 1,
        })
      );
    }

    test("keeps a run named by number from deletion", async () => {
      await writeConsumer({ workflow: "bug sweep", run: 1 });
      await assert.rejects(
        () =>
          new WorkflowLineageRepository().deleteRun(
            workspaceRoot,
            workflowKey,
            olderRunRef
          ),
        /selected as prior context/
      );
    });

    test("lets a run go when the source only follows the latest run", async () => {
      await writeConsumer({ workflow: workflowKey });
      await new WorkflowLineageRepository().deleteRun(
        workspaceRoot,
        workflowKey,
        olderRunRef
      );
    });
  });
});
