import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { ProjectStateRegistry } from "../../utils/ProjectStateRegistry";
import { relinkUserProject } from "../../utils/ProjectStateLifecycle";
import {
  canonicalStatePath,
  legacyProjectKey,
  projectKey,
  userProjectsRoot,
} from "../../utils/ProjectStatePaths";
import { formatRunRef } from "../../utils/WorkflowPaths";
import {
  RUN_HISTORY_LOCATIONS,
  RUNNER_IDS,
} from "../../types/DashboardConstants";
import {
  relinkHistoryCommand,
  type HistoryCommandIo,
} from "../../cli/HistoryCommands";

/**
 * One repository reached through a symlinked directory: `linked/repo` and
 * `real/repo` name the same project. ctrlyoke 0.2.0 keyed history by the
 * spelling, so these tests fabricate its layout under the legacy key.
 */
suite("Project state through symlinked paths", () => {
  const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
  let sandbox: string;
  let realRepo: string;
  let linkedRepo: string;
  let originalStateHome: string | undefined;

  setup(async () => {
    originalStateHome = process.env.CTRLYOKE_HOME;
    sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-symlinked-"))
    );
    process.env.CTRLYOKE_HOME = path.join(sandbox, "home");
    await fs.mkdir(path.join(sandbox, "real", "repo"), { recursive: true });
    await fs.symlink(
      path.join(sandbox, "real"),
      path.join(sandbox, "linked"),
      LINK_TYPE
    );
    realRepo = path.join(sandbox, "real", "repo");
    linkedRepo = path.join(sandbox, "linked", "repo");
  });

  teardown(async () => {
    if (originalStateHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = originalStateHome;
    }
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  test("every spelling of a project derives one key", () => {
    assert.strictEqual(canonicalStatePath(linkedRepo), realRepo);
    assert.strictEqual(projectKey(linkedRepo), projectKey(realRepo));
    assert.notStrictEqual(legacyProjectKey(linkedRepo), projectKey(realRepo));
  });

  test("a missing path resolves its nearest existing ancestor", () => {
    assert.strictEqual(
      canonicalStatePath(path.join(linkedRepo, "gone", "deeper")),
      path.join(realRepo, "gone", "deeper")
    );
  });

  test("startup adopts history filed under a symlinked spelling's key", async () => {
    const legacyRoot = await makeLegacyProject(
      linkedRepo,
      Date.UTC(2026, 0, 2)
    );

    const result = await registry().initialize(realRepo);

    assert.strictEqual(result.projectRoot, canonicalProjectRoot());
    await assert.rejects(() => fs.stat(legacyRoot), { code: "ENOENT" });
    assert.deepStrictEqual(await runRefs(canonicalProjectRoot()), [
      formatRunRef(Date.UTC(2026, 0, 2)),
    ]);
    assert.strictEqual(
      (await readMetadata(canonicalProjectRoot())).statePath,
      realRepo
    );
  });

  test("keeps the more recent history when both keys hold runs", async () => {
    const canonicalRoot = await makeLegacyProject(
      realRepo,
      Date.UTC(2026, 0, 1)
    );
    const legacyRoot = await makeLegacyProject(
      linkedRepo,
      Date.UTC(2026, 0, 5)
    );

    await registry().initialize(linkedRepo);

    assert.strictEqual(canonicalRoot, canonicalProjectRoot());
    assert.deepStrictEqual(await runRefs(canonicalRoot), [
      formatRunRef(Date.UTC(2026, 0, 5)),
    ]);
    // The older history is left intact under the other key.
    assert.deepStrictEqual(await runRefs(legacyRoot), [
      formatRunRef(Date.UTC(2026, 0, 1)),
    ]);

    // A later startup sees the canonical copy as newest and moves nothing.
    await registry().initialize(realRepo);
    assert.deepStrictEqual(await runRefs(canonicalRoot), [
      formatRunRef(Date.UTC(2026, 0, 5)),
    ]);
  });

  test("leaves the canonical history in place when it is the newer one", async () => {
    const canonicalRoot = await makeLegacyProject(
      realRepo,
      Date.UTC(2026, 0, 9)
    );
    const legacyRoot = await makeLegacyProject(
      linkedRepo,
      Date.UTC(2026, 0, 3)
    );

    await registry().initialize(realRepo);

    assert.deepStrictEqual(await runRefs(canonicalRoot), [
      formatRunRef(Date.UTC(2026, 0, 9)),
    ]);
    assert.deepStrictEqual(await runRefs(legacyRoot), [
      formatRunRef(Date.UTC(2026, 0, 3)),
    ]);
  });

  test("does not move history while a runner holds it", async () => {
    const runAt = Date.UTC(2026, 0, 2);
    const legacyRoot = await makeLegacyProject(linkedRepo, runAt);
    const now = Date.now();
    await fs.writeFile(
      path.join(legacyRoot, ".runs", "workflow", "runner.json"),
      JSON.stringify({
        workflowKey: "workflow",
        runRef: formatRunRef(runAt),
        runner: RUNNER_IDS.VSCODE,
        pid: process.pid,
        ownerToken: "owner-token",
        startedAt: now,
        lastHeartbeat: now,
      })
    );

    await registry().initialize(realRepo);

    assert.deepStrictEqual(await runRefs(legacyRoot), [formatRunRef(runAt)]);
    assert.deepStrictEqual(await runRefs(canonicalProjectRoot()), []);
  });

  test("relink finds a source typed through a symlink and keys the destination canonically", async () => {
    const runAt = Date.UTC(2026, 0, 2);
    const legacyRoot = await makeLegacyProject(linkedRepo, runAt);
    const realCopy = path.join(sandbox, "real", "repo2");
    await fs.mkdir(realCopy);
    const linkedCopy = path.join(sandbox, "linked", "repo2");

    const output: string[] = [];
    await relinkHistoryCommand(
      linkedRepo,
      linkedCopy,
      { yes: true },
      makeIo(output)
    );

    const newProjectRoot = path.join(userProjectsRoot(), projectKey(realCopy));
    await assert.rejects(() => fs.stat(legacyRoot), { code: "ENOENT" });
    assert.deepStrictEqual(await runRefs(newProjectRoot), [
      formatRunRef(runAt),
    ]);
    assert.strictEqual(
      (await readMetadata(newProjectRoot)).statePath,
      realCopy
    );
    assert.ok(
      output.some((line) => line.includes(`resolves to "${realCopy}"`)),
      output.join("\n")
    );

    // Opening the copy by either spelling finds the relinked history.
    const opened = await registry().initialize(realCopy);
    assert.strictEqual(opened.projectRoot, newProjectRoot);
  });

  test("relink of a canonical source moves nothing else", async () => {
    await makeLegacyProject(realRepo, Date.UTC(2026, 0, 2));
    const destination = path.join(sandbox, "real", "renamed");
    await fs.mkdir(destination);

    const result = await relinkUserProject(realRepo, destination, {
      dryRun: true,
      gitToplevel: null,
    });

    assert.strictEqual(result.oldProjectRoot, canonicalProjectRoot());
    assert.strictEqual(result.metadata.statePath, destination);
  });

  function registry(): ProjectStateRegistry {
    return new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.USER);
  }

  function canonicalProjectRoot(): string {
    return path.join(userProjectsRoot(), projectKey(realRepo));
  }

  /** The directory ctrlyoke 0.2.0 would have written for this spelling. */
  async function makeLegacyProject(
    spelling: string,
    runAt: number
  ): Promise<string> {
    const projectRoot = path.join(
      userProjectsRoot(),
      legacyProjectKey(spelling)
    );
    const runDir = path.join(
      projectRoot,
      ".runs",
      "workflow",
      formatRunRef(runAt)
    );
    await fs.mkdir(runDir, { recursive: true });
    const stamp = new Date(runAt).toISOString();
    await fs.writeFile(
      path.join(projectRoot, "project.json"),
      JSON.stringify({
        schemaVersion: 1,
        statePath: spelling,
        createdAt: stamp,
        lastOpenedAt: stamp,
      })
    );
    return projectRoot;
  }

  async function runRefs(projectRoot: string): Promise<string[]> {
    try {
      return (
        await fs.readdir(path.join(projectRoot, ".runs", "workflow"))
      ).filter((name) => name.startsWith("run-"));
    } catch {
      return [];
    }
  }

  async function readMetadata(
    projectRoot: string
  ): Promise<{ statePath: string }> {
    return JSON.parse(
      await fs.readFile(path.join(projectRoot, "project.json"), "utf8")
    ) as { statePath: string };
  }

  function makeIo(output: string[]): HistoryCommandIo {
    return {
      writeOut: (message) => output.push(message),
      writeErr: (message) => output.push(message),
      isInteractive: false,
      confirm: async () => true,
    };
  }
});
