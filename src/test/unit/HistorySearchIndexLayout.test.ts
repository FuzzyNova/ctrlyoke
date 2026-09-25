import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  getSearchIndexDir,
  getSearchIndexRoot,
  INDEX_SCHEMA_VERSION,
  pruneSearchIndexVersions,
  searchIndexVersionDirName,
} from "../../core/orchestration/HistorySearchIndexLayout";
import { RUN_HISTORY_LOCATIONS } from "../../types/DashboardConstants";
import {
  INSTALLATION_KINDS,
  recordInstallation,
} from "../../utils/CtrlyokeInstallations";

suite("HistorySearchIndexLayout", () => {
  let tempRoot: string;
  let indexRoot: string;
  let previousHome: string | undefined;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-index-"));
    previousHome = process.env.CTRLYOKE_HOME;
    process.env.CTRLYOKE_HOME = path.join(tempRoot, "home");
    indexRoot = path.join(tempRoot, "index");
    await fs.mkdir(indexRoot, { recursive: true });
  });

  teardown(async () => {
    if (previousHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = previousHome;
    }
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  async function record(
    name: string,
    indexSchemaVersion: string | undefined
  ): Promise<void> {
    const packageRoot = path.join(tempRoot, name);
    await fs.mkdir(packageRoot, { recursive: true });
    await recordInstallation({
      kind: INSTALLATION_KINDS.CLI,
      version: "0.1.0",
      packageRoot,
      ...(indexSchemaVersion ? { indexSchemaVersion } : {}),
    });
  }

  async function seed(...entries: string[]): Promise<void> {
    for (const entry of entries) {
      if (entry.endsWith("/")) {
        await fs.mkdir(path.join(indexRoot, entry), { recursive: true });
      } else {
        await fs.writeFile(path.join(indexRoot, entry), "{}", "utf8");
      }
    }
  }

  async function remaining(): Promise<string[]> {
    return (await fs.readdir(indexRoot)).sort();
  }

  const current = searchIndexVersionDirName(INDEX_SCHEMA_VERSION);

  test("each schema version gets its own directory under .search-index", () => {
    const workspace = path.join(tempRoot, "ws");
    const dir = getSearchIndexDir(workspace, RUN_HISTORY_LOCATIONS.WORKSPACE);
    assert.strictEqual(path.basename(dir), current);
    assert.strictEqual(
      path.dirname(dir),
      getSearchIndexRoot(workspace, RUN_HISTORY_LOCATIONS.WORKSPACE)
    );
    assert.strictEqual(path.basename(path.dirname(dir)), ".search-index");
  });

  test("keeps versions live installations use and prunes the rest", async () => {
    await record("other", "9.9.9");
    await seed(`${current}/`, "v9.9.9/", "v1.0.0/");

    await pruneSearchIndexVersions(indexRoot);

    assert.deepStrictEqual(await remaining(), [current, "v9.9.9"].sort());
  });

  test("removes the pre-versioning index once no installation can use it", async () => {
    await record("self", INDEX_SCHEMA_VERSION);
    await seed(`${current}/`, "manifest.json", "documents/", "rebuild-1/");

    await pruneSearchIndexVersions(indexRoot);

    assert.deepStrictEqual(await remaining(), [current]);
  });

  test("keeps the pre-versioning index while an older installation may use it", async () => {
    await record("self", INDEX_SCHEMA_VERSION);
    await record("older", undefined);
    await seed(`${current}/`, "manifest.json", "documents/");

    await pruneSearchIndexVersions(indexRoot);

    assert.deepStrictEqual(
      await remaining(),
      [current, "documents", "manifest.json"].sort()
    );
  });

  test("never throws when the index root is missing", async () => {
    await pruneSearchIndexVersions(path.join(tempRoot, "missing"));
  });
});
