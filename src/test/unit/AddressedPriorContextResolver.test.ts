import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { AddressedPriorContextResolver } from "../../core/orchestration/AddressedPriorContextResolver";
import { RunOutputResolver } from "../../core/orchestration/RunOutputResolver";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

suite("AddressedPriorContextResolver", () => {
  let workspaceRoot: string;
  const workflowKey = "source-2026-07-20T00-00-00" as WorkflowKey;
  const runRef = "run-2026-07-20T00-00-00-000Z" as RunRef;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-context-"));
    await fs.mkdir(WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef), {
      recursive: true,
    });
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("keeps same-run defaults and resolves a terminal source only by stable address", async () => {
    let addressedDetail: string | undefined;
    const resolver = {
      getManifest: async () => ({ completedAt: 1 }),
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
      ["previous", { context: { workflowKey, runRef }, detail: "summary" }],
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

  test("routes { previous: N } to the same run instead of treating it as an address", async () => {
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

  test("rejects traversal, missing sources, and nonterminal source manifests without path leakage", async () => {
    const resolver = {
      getManifest: async () => ({ completedAt: undefined }),
      resolveAllPriorContextItems: async () => [],
    } as unknown as RunOutputResolver;
    const service = new AddressedPriorContextResolver(workspaceRoot, resolver);
    await assert.rejects(
      () =>
        service.resolve(
          [{ workflowKey: "../outside" as WorkflowKey, runRef }],
          async () => []
        ),
      /unavailable, deleted, or not yet complete/
    );
    await assert.rejects(
      () => service.resolve([{ workflowKey, runRef }], async () => []),
      /unavailable, deleted, or not yet complete/
    );
  });

  test("keeps an addressed source from manual deletion and retention", async () => {
    const repository = new WorkflowLineageRepository();
    await fs.writeFile(
      WorkflowPaths.descriptorPath(workspaceRoot, workflowKey),
      JSON.stringify({
        schemaVersion: 1,
        workflowKey,
        workflowName: "source",
        isFavorite: false,
        createdAt: 1,
        lastModifiedAt: 1,
        nextRunId: 2,
        revision: 1,
      })
    );
    const lineage = await repository.createLineage(
      workspaceRoot,
      "consumer",
      "consumer"
    );
    await fs.writeFile(
      lineage.draftFilePath,
      JSON.stringify({
        steps: [
          { prompt: "use source", priorContext: { workflowKey, runRef } },
        ],
      })
    );
    await assert.rejects(
      () => repository.deleteRun(workspaceRoot, workflowKey, runRef),
      /selected as prior context/
    );
  });
});
