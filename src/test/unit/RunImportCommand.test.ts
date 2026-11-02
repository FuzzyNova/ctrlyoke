import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import {
  importRunCommand,
  type RunImportCommandIo,
} from "../../cli/RunImportCommand";
import type { CliWorkspaceBootstrap } from "../../cli/CliWorkspaceBootstrap";
import { RunBundleFormatError } from "../../core/orchestration/RunBundleReader";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("RunImportCommand", () => {
  let root: string;
  let workspaceRoot: string;
  let bundleDir: string;
  let output: string[];
  let workspace: CliWorkspaceBootstrap;

  setup(async () => {
    root = makeTempDir("ctrlyoke-run-import-command-");
    workspaceRoot = path.join(root, "workspace");
    bundleDir = path.join(root, "fixture.ctrlyokerun");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(bundleDir, { recursive: true });
    await writeFixtureBundle(bundleDir);
    const lineageRepository = new WorkflowLineageRepository();
    workspace = {
      workspaceRoot,
      createOutputHistoryManager: () => new OutputHistoryManager(workspaceRoot),
      createLineageRepository: () => lineageRepository,
    };
    output = [];
  });

  teardown(() => removeTempDir(root));

  test("imports a bundle and reports its provenance and history command", async () => {
    await importRunCommand({ bundleDir }, io(), dependencies());
    assert.match(output[0], /^Import preview: Imported fixture$/);
    assert.ok(
      output.some((line) => /^Imported Imported fixture as /.test(line))
    );
    assert.ok(output.includes("  2 events"));
    assert.ok(
      output.some((line) => line.includes("${workspaceFolder}/source"))
    );
    assert.ok(output.some((line) => line.includes("ctrlyoke 0.4.1")));
    assert.match(output.at(-1) ?? "", /^View it with: ctrlyoke history show/);
  });

  test("emits the versioned success envelope in JSON mode", async () => {
    await importRunCommand({ bundleDir, json: true }, io(), dependencies());
    assert.strictEqual(output.length, 1);
    const result = JSON.parse(output[0]) as {
      schemaVersion: number;
      success: boolean;
      status: string;
      workflowKey: string;
      runRef: string;
      eventCount: number;
      importedFrom: {
        sourceRoot: string;
        exportedAt: string;
        exportedByVersion: string;
      };
      preview: {
        provenance: { workflowName: string };
        pendingSteps: unknown[];
      };
    };
    assert.strictEqual(result.schemaVersion, 1);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, "imported");
    assert.ok(result.workflowKey);
    assert.ok(result.runRef);
    assert.strictEqual(result.eventCount, 2);
    assert.deepStrictEqual(result.importedFrom, {
      sourceRoot: "${workspaceFolder}/source",
      exportedAt: "2026-10-31T12:00:00.000Z",
      exportedByVersion: "0.4.1",
    });
    assert.strictEqual(
      result.preview.provenance.workflowName,
      "Imported fixture"
    );
    assert.deepStrictEqual(result.preview.pendingSteps, []);
  });

  test("reports an existing import and names --again", async () => {
    await importRunCommand({ bundleDir }, io(), dependencies());
    output = [];
    await importRunCommand({ bundleDir }, io(), dependencies());
    assert.ok(
      output.some((line) => /^Already imported Imported fixture as /.test(line))
    );
    assert.ok(output.some((line) => line.includes("--again")));
  });

  test("--again creates another imported lineage", async () => {
    await importRunCommand({ bundleDir }, io(), dependencies());
    const firstKey = output
      .find((line) => line.startsWith("Imported Imported fixture as "))
      ?.match(/as ([^ ]+)/)?.[1];
    output = [];
    await importRunCommand({ bundleDir, again: true }, io(), dependencies());
    const secondKey = output
      .find((line) => line.startsWith("Imported Imported fixture as "))
      ?.match(/as ([^ ]+)/)?.[1];
    assert.ok(firstKey);
    assert.ok(secondKey);
    assert.notStrictEqual(firstKey, secondKey);
  });

  test("reports malformed bundles as human errors", async () => {
    await fs.writeFile(path.join(bundleDir, "run.json"), "{}", "utf8");
    await assert.rejects(
      importRunCommand({ bundleDir }, io(), dependencies()),
      RunBundleFormatError
    );
  });

  test("emits a JSON error envelope and usage exit code for malformed bundles", async () => {
    await fs.writeFile(path.join(bundleDir, "run.json"), "{}", "utf8");
    let exitCode: number | undefined;
    await importRunCommand(
      { bundleDir, json: true },
      io(),
      dependencies({ setExitCode: (code) => (exitCode = code) })
    );
    assert.strictEqual(output.length, 1);
    assert.deepStrictEqual(JSON.parse(output[0]), {
      schemaVersion: 1,
      success: false,
      error: `${bundleDir} is not a ctrlyoke run bundle.`,
    });
    assert.strictEqual(exitCode, 2);
  });

  function io(): RunImportCommandIo {
    return {
      writeOut: (message) => output.push(message),
    };
  }

  function dependencies(
    extras: Partial<Parameters<typeof importRunCommand>[2]> = {}
  ): Parameters<typeof importRunCommand>[2] {
    return {
      bootstrapCliWorkspace: async () => workspace,
      ...extras,
    };
  }
});

async function writeFixtureBundle(bundleDir: string): Promise<void> {
  await fs.writeFile(
    path.join(bundleDir, "run.json"),
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
    path.join(bundleDir, "workflow.ctrlyoke.json"),
    JSON.stringify({ steps: [{ prompt: "fixture" }] })
  );
  await fs.writeFile(
    path.join(bundleDir, "manifest.json"),
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
      nextSequence: 3,
      lastUpdatedAt: 200,
    })
  );
  await fs.writeFile(path.join(bundleDir, "events.jsonl"), "", "utf8");
}
