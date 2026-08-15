import * as assert from "assert";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { suite, test } from "mocha";

const MIGRATION_SCRIPT = path.resolve(
  __dirname,
  "../../../scripts/migrate-runs-to-user-scope.mjs"
);

interface MigrationResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runMigration(
  stateRoot: string,
  stateHome: string,
  args: string[] = [],
  forceExdev = false
): MigrationResult {
  const result = spawnSync(
    process.execPath,
    [MIGRATION_SCRIPT, "--state-root", stateRoot, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CTRLYOKE_HOME: stateHome,
        ...(forceExdev
          ? { CTRLYOKE_MIGRATION_TEST_FORCE_EXDEV: "1" }
          : { CTRLYOKE_MIGRATION_TEST_FORCE_EXDEV: undefined }),
      },
    }
  );
  if (result.error) throw result.error;
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

function expectedProjectKey(stateRoot: string): string {
  const resolved = path.resolve(stateRoot);
  const basename = path
    .basename(resolved)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
  const slug =
    basename
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "project";
  const folded =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return `${slug}-${createHash("sha256").update(folded).digest("hex").slice(0, 12)}`;
}

function destinationFor(stateRoot: string, stateHome: string): string {
  return path.join(stateHome, "projects", expectedProjectKey(stateRoot));
}

suite("migrate-runs-to-user-scope", () => {
  async function withWorkspace(
    callback: (stateRoot: string, stateHome: string) => Promise<void>
  ): Promise<void> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-user-scope-")
    );
    const stateRoot = path.join(root, "workspace");
    const stateHome = path.join(root, "state-home");
    await fs.mkdir(stateRoot);
    try {
      await callback(stateRoot, stateHome);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  test("prints the implementation-compatible key without touching history", async () => {
    await withWorkspace(async (stateRoot, stateHome) => {
      const result = runMigration(stateRoot, stateHome, ["--print-key"]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        new RegExp(`Project key: ${expectedProjectKey(stateRoot)}`)
      );
      assert.match(
        result.stdout,
        new RegExp(
          `Destination: ${destinationFor(stateRoot, stateHome).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
        )
      );
      await assert.rejects(() => fs.stat(path.join(stateRoot, ".ctrlyoke")), {
        code: "ENOENT",
      });
    });
  });

  test("is dry-run safe", async () => {
    await withWorkspace(async (stateRoot, stateHome) => {
      const runFile = path.join(
        stateRoot,
        ".ctrlyoke",
        ".runs",
        "demo",
        "workflow.json"
      );
      const observedFile = path.join(
        stateRoot,
        ".ctrlyoke",
        ".usage",
        "observed-usage.json"
      );
      await writeJson(runFile, { workflowKey: "demo" });
      await writeJson(observedFile, {
        schemaVersion: 1,
        runs: {},
        buckets: {},
      });

      const result = runMigration(stateRoot, stateHome);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /DRY RUN/);
      await fs.access(runFile);
      await fs.access(observedFile);
      await assert.rejects(
        () => fs.stat(destinationFor(stateRoot, stateHome)),
        {
          code: "ENOENT",
        }
      );
    });
  });

  test("refuses a live runner lock before creating the destination", async () => {
    await withWorkspace(async (stateRoot, stateHome) => {
      const lockFile = path.join(
        stateRoot,
        ".ctrlyoke",
        ".runs",
        "demo",
        "runner.json"
      );
      await writeJson(lockFile, { pid: process.pid });

      const result = runMigration(stateRoot, stateHome, ["--apply"]);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Live runner PID/);
      await fs.access(lockFile);
      await assert.rejects(
        () => fs.stat(destinationFor(stateRoot, stateHome)),
        {
          code: "ENOENT",
        }
      );
    });
  });

  test("refuses to merge an existing lineage", async () => {
    await withWorkspace(async (stateRoot, stateHome) => {
      const sourceRun = path.join(
        stateRoot,
        ".ctrlyoke",
        ".runs",
        "demo",
        "workflow.json"
      );
      const destination = destinationFor(stateRoot, stateHome);
      await writeJson(sourceRun, { workflowKey: "demo" });
      await writeJson(path.join(destination, "project.json"), {
        schemaVersion: 1,
        statePath: path.resolve(stateRoot),
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      });
      await writeJson(
        path.join(destination, ".runs", "already-there", "workflow.json"),
        {
          workflowKey: "already-there",
        }
      );

      const result = runMigration(stateRoot, stateHome, ["--apply"]);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Destination conflict/);
      await fs.access(sourceRun);
    });
  });

  test("uses the fsync staging fallback for EXDEV and cleans rebuildable sources", async () => {
    await withWorkspace(async (stateRoot, stateHome) => {
      const sourceRun = path.join(
        stateRoot,
        ".ctrlyoke",
        ".runs",
        "demo",
        "workflow.json"
      );
      const observedFile = path.join(
        stateRoot,
        ".ctrlyoke",
        ".usage",
        "observed-usage.json"
      );
      const lifetimeFile = path.join(
        stateRoot,
        ".ctrlyoke",
        ".usage",
        "lifetime-stats.json"
      );
      const searchIndex = path.join(
        stateRoot,
        ".ctrlyoke",
        ".search-index",
        "index.json"
      );
      await writeJson(sourceRun, { workflowKey: "demo" });
      await writeJson(observedFile, {
        schemaVersion: 1,
        runs: { demo: 1 },
        buckets: {},
      });
      await writeJson(lifetimeFile, { schemaVersion: 1, lineages: {} });
      await writeJson(searchIndex, { derived: true });

      const result = runMigration(stateRoot, stateHome, ["--apply"], true);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /EXDEV fallback/);
      const destination = destinationFor(stateRoot, stateHome);
      await fs.access(path.join(destination, ".runs", "demo", "workflow.json"));
      await fs.access(path.join(destination, ".usage", "observed-usage.json"));
      await assert.rejects(() => fs.stat(sourceRun), { code: "ENOENT" });
      await assert.rejects(() => fs.stat(observedFile), { code: "ENOENT" });
      await assert.rejects(() => fs.stat(lifetimeFile), { code: "ENOENT" });
      await assert.rejects(() => fs.stat(searchIndex), { code: "ENOENT" });
    });
  });
});
