import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { suite, test } from "mocha";

const MIGRATION_SCRIPT = path.resolve(
  __dirname,
  "../../../dev/migrate-runs-layout.mjs"
);
const WORKING_FILE_NAME = "workflow.ctrlyoke.json";

interface MigrationResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runMigration(workspace: string, apply = true): MigrationResult {
  const result = spawnSync(
    process.execPath,
    [MIGRATION_SCRIPT, workspace, ...(apply ? ["--apply"] : [])],
    { encoding: "utf8" }
  );
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeLegacyWorkingFile(
  workspace: string,
  legacyId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const filePath = path.join(
    workspace,
    ".ctrlyoke",
    ".working",
    `${legacyId}.ctrlyoke.json`
  );
  await writeJson(filePath, {
    workflowName: "Migrated workflow",
    steps: [
      {
        prompt: "Finish the migration",
        _runtime: { sessionId: "resume-me", completedAt: 2_000 },
      },
    ],
    _runtime: { currentIndex: 1, executionState: "completed" },
    ...overrides,
  });
  return filePath;
}

async function writeLegacyRun(
  workspace: string,
  legacyId: string,
  name: string,
  manifest: Record<string, unknown>
): Promise<string> {
  const runDirectory = path.join(
    workspace,
    ".ctrlyoke",
    ".history",
    legacyId,
    name
  );
  await writeJson(path.join(runDirectory, "manifest.json"), manifest);
  await fs.writeFile(
    path.join(runDirectory, "events.jsonl"),
    '{"sequence":1,"eventType":"legacy"}\n',
    "utf8"
  );
  return runDirectory;
}

async function listDirectories(directory: string): Promise<string[]> {
  return (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

suite("migrate-runs-layout", () => {
  async function withWorkspace(
    callback: (workspace: string) => Promise<void>
  ): Promise<void> {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-migrate-runs-")
    );
    try {
      await callback(workspace);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }

  test("stages a complete lineage, preserves run-id gaps, and reports approximate history", async () => {
    await withWorkspace(async (workspace) => {
      const legacyId = "build-2025-01-01T00-00-00";
      await writeLegacyWorkingFile(workspace, legacyId);
      await writeLegacyRun(workspace, legacyId, "run-2025-01-01T00-00-00Z", {
        runId: 2,
        startedAt: 1_000,
        executionState: "completed",
      });
      await writeLegacyRun(workspace, legacyId, "run-2025-01-02T00-00-00Z", {
        runId: 7,
        startedAt: 2_000,
        executionState: "completed",
      });

      const result = runMigration(workspace);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 historical definition approximate/);

      const lineage = path.join(workspace, ".ctrlyoke", ".runs", legacyId);
      const descriptor = JSON.parse(
        await fs.readFile(path.join(lineage, "workflow.json"), "utf8")
      ) as { latestRunRef: string; nextRunId: number };
      assert.strictEqual(descriptor.nextRunId, 8);

      const runRefs = (await listDirectories(lineage)).filter((name) =>
        name.startsWith("run-")
      );
      assert.strictEqual(runRefs.length, 2);
      const manifests = await Promise.all(
        runRefs.map(async (runRef) => ({
          runRef,
          manifest: JSON.parse(
            await fs.readFile(
              path.join(lineage, runRef, "manifest.json"),
              "utf8"
            )
          ) as { runId: number; initialDefinition?: unknown },
        }))
      );
      assert.deepStrictEqual(
        manifests.map(({ manifest }) => manifest.runId).sort((a, b) => a - b),
        [2, 7]
      );
      assert.ok(manifests.every(({ manifest }) => manifest.initialDefinition));

      const latestDefinition = JSON.parse(
        await fs.readFile(
          path.join(lineage, descriptor.latestRunRef, WORKING_FILE_NAME),
          "utf8"
        )
      ) as { steps: Array<{ _runtime?: unknown }> };
      assert.ok(latestDefinition.steps[0]?._runtime);

      const older = manifests.find(
        ({ runRef }) => runRef !== descriptor.latestRunRef
      );
      assert.ok(older);
      const olderDefinition = JSON.parse(
        await fs.readFile(
          path.join(lineage, older!.runRef, WORKING_FILE_NAME),
          "utf8"
        )
      ) as { steps: Array<{ _runtime?: unknown }> };
      assert.strictEqual(olderDefinition.steps[0]?._runtime, undefined);
      await assert.rejects(
        fs.access(
          path.join(
            workspace,
            ".ctrlyoke",
            ".working",
            `${legacyId}.ctrlyoke.json`
          )
        )
      );

      const rerun = runMigration(workspace);
      assert.strictEqual(rerun.status, 0, rerun.stderr);
      assert.match(rerun.stdout, /nothing to migrate/);
    });
  });

  test("is dry-run safe and refuses a pre-existing destination without touching legacy data", async () => {
    await withWorkspace(async (workspace) => {
      const legacyId = "collision-2025-01-01T00-00-00";
      const workingFile = await writeLegacyWorkingFile(workspace, legacyId);

      const dryRun = runMigration(workspace, false);
      assert.strictEqual(dryRun.status, 0, dryRun.stderr);
      assert.match(dryRun.stdout, /PLAN/);
      await fs.access(workingFile);
      await assert.rejects(
        fs.access(path.join(workspace, ".ctrlyoke", ".runs"))
      );

      await fs.mkdir(path.join(workspace, ".ctrlyoke", ".runs", legacyId), {
        recursive: true,
      });
      const collision = runMigration(workspace);
      assert.strictEqual(collision.status, 0, collision.stderr);
      assert.match(collision.stdout, /SKIP/);
      await fs.access(workingFile);
    });
  });

  test("quarantines orphan history and tolerates an interrupted staging directory", async () => {
    await withWorkspace(async (workspace) => {
      const legacyId = "partial-2025-01-01T00-00-00";
      await writeLegacyWorkingFile(workspace, legacyId);
      await fs.mkdir(
        path.join(workspace, ".ctrlyoke", ".runs", ".migrating-interrupted"),
        {
          recursive: true,
        }
      );
      await writeLegacyRun(
        workspace,
        "orphan-2025-01-01T00-00-00",
        "run-2025-01-01T00-00-00Z",
        {
          startedAt: 1_000,
        }
      );

      const result = runMigration(workspace);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /QUARANTINED/);
      await fs.access(
        path.join(workspace, ".ctrlyoke", ".runs", ".migrating-interrupted")
      );
      const quarantined = await listDirectories(
        path.join(workspace, ".ctrlyoke", ".migration-rejected")
      );
      assert.strictEqual(quarantined.length, 1);
    });
  });

  test("leaves corrupt and symlinked legacy sources untouched", async () => {
    await withWorkspace(async (workspace) => {
      const corruptId = "corrupt-2025-01-01T00-00-00";
      const corruptWorking = await writeLegacyWorkingFile(workspace, corruptId);
      const corruptManifest = path.join(
        workspace,
        ".ctrlyoke",
        ".history",
        corruptId,
        "run-2025-01-01T00-00-00Z",
        "manifest.json"
      );
      await fs.mkdir(path.dirname(corruptManifest), { recursive: true });
      await fs.writeFile(corruptManifest, "not json", "utf8");
      const corruptResult = runMigration(workspace);
      assert.strictEqual(corruptResult.status, 1);
      await fs.access(corruptWorking);

      const symlinkId = "symlink-2025-01-01T00-00-00";
      const symlinkWorking = await writeLegacyWorkingFile(workspace, symlinkId);
      const runDirectory = await writeLegacyRun(
        workspace,
        symlinkId,
        "run-2025-01-01T00-00-00Z",
        { startedAt: 1_000 }
      );
      const outside = path.join(workspace, "outside.txt");
      await fs.writeFile(outside, "outside", "utf8");
      try {
        await fs.symlink(outside, path.join(runDirectory, "outside-link"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }

      const symlinkResult = runMigration(workspace);
      assert.strictEqual(symlinkResult.status, 1);
      await fs.access(symlinkWorking);
      await assert.rejects(
        fs.access(path.join(workspace, ".ctrlyoke", ".runs", symlinkId))
      );
    });
  });

  test("sanitizes a Windows-reserved legacy name into a safe lineage key", async () => {
    await withWorkspace(async (workspace) => {
      await writeLegacyWorkingFile(workspace, "CON");
      const result = runMigration(workspace);
      assert.strictEqual(result.status, 0, result.stderr);
      await fs.access(
        path.join(
          workspace,
          ".ctrlyoke",
          ".runs",
          "workflow-con",
          "draft",
          WORKING_FILE_NAME
        )
      );
    });
  });

  test("migrates a flat legacy run manifest", async () => {
    await withWorkspace(async (workspace) => {
      const legacyId = "flat-2025-01-01T00-00-00";
      await writeLegacyWorkingFile(workspace, legacyId);
      await writeJson(
        path.join(
          workspace,
          ".ctrlyoke",
          ".history",
          legacyId,
          "run-2025-01-01T00-00-00Z.json"
        ),
        { runId: 4, startedAt: 1_000 }
      );

      const result = runMigration(workspace);
      assert.strictEqual(result.status, 0, result.stderr);
      const lineage = path.join(workspace, ".ctrlyoke", ".runs", legacyId);
      const [runRef] = (await listDirectories(lineage)).filter((name) =>
        name.startsWith("run-")
      );
      assert.ok(runRef);
      await fs.access(path.join(lineage, runRef, WORKING_FILE_NAME));
      await fs.access(path.join(lineage, runRef, "manifest.json"));
      await fs.access(path.join(lineage, runRef, "events.jsonl"));
    });
  });
});
