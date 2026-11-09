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
import { definitionAnchorPath } from "../../utils/WorkflowPaths";
import {
  anchorRunDefinitionOnDisk,
  verifyRunDefinitionFile,
} from "../../utils/RunDefinitionAnchor";
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
  let differentlyNamedLink: string;
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
    differentlyNamedLink = path.join(sandbox, "work");
    await fs.symlink(realRepo, differentlyNamedLink, LINK_TYPE);
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

  test("startup adopts history filed under a differently named symlink", async () => {
    const legacyRoot = await makeLegacyProject(
      differentlyNamedLink,
      Date.UTC(2026, 0, 2)
    );

    await registry().initialize(realRepo);

    assert.deepStrictEqual(await runRefs(canonicalProjectRoot()), [
      formatRunRef(Date.UTC(2026, 0, 2)),
    ]);
    await assert.rejects(() => fs.stat(legacyRoot), { code: "ENOENT" });
  });

  test("workspace startup merges split anchors and preserves the newer copy", async () => {
    const canonicalRoot = await makeProjectScaffold(realRepo);
    const legacyRoot = await makeProjectScaffold(linkedRepo);
    const runA = await makeWorkspaceRun(Date.UTC(2026, 0, 1), "A");
    const runB = await makeWorkspaceRun(Date.UTC(2026, 0, 2), "B");
    await anchorRunDefinitionOnDisk(runA);
    await anchorRunDefinitionOnDisk(runB);
    const canonicalAnchorB = definitionAnchorPath(runB);
    assert.ok(canonicalAnchorB);
    const legacyAnchorB = path.join(
      legacyRoot,
      path.relative(canonicalRoot, canonicalAnchorB)
    );
    await fs.mkdir(path.dirname(legacyAnchorB), { recursive: true });
    await fs.rename(canonicalAnchorB, legacyAnchorB);

    await new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.WORKSPACE).initialize(
      linkedRepo
    );

    assert.strictEqual(
      (await verifyRunDefinitionFile(runB))?.verdict.status,
      "trusted"
    );
    assert.ok(await fs.stat(path.join(canonicalRoot, ".definition-anchors")));
  });

  test("workspace anchor merge keeps a newer legacy anchor for the same run", async () => {
    const canonicalRoot = await makeProjectScaffold(realRepo);
    const legacyRoot = await makeProjectScaffold(linkedRepo);
    const runFile = await makeWorkspaceRun(Date.UTC(2026, 0, 3), "current");
    await anchorRunDefinitionOnDisk(runFile);
    const canonicalAnchor = definitionAnchorPath(runFile);
    assert.ok(canonicalAnchor);
    const legacyAnchor = path.join(
      legacyRoot,
      path.relative(canonicalRoot, canonicalAnchor)
    );
    await fs.mkdir(path.dirname(legacyAnchor), { recursive: true });
    const anchor = JSON.parse(await fs.readFile(canonicalAnchor, "utf8")) as {
      recordedAt: number;
    };
    anchor.recordedAt += 1000;
    await fs.writeFile(legacyAnchor, JSON.stringify(anchor));

    await new ProjectStateRegistry(RUN_HISTORY_LOCATIONS.WORKSPACE).initialize(
      linkedRepo
    );

    const merged = JSON.parse(await fs.readFile(canonicalAnchor, "utf8")) as {
      recordedAt: number;
    };
    assert.strictEqual(merged.recordedAt, anchor.recordedAt);
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

  async function makeProjectScaffold(spelling: string): Promise<string> {
    const projectRoot = path.join(
      userProjectsRoot(),
      legacyProjectKey(spelling)
    );
    await fs.mkdir(projectRoot, { recursive: true });
    const stamp = new Date(0).toISOString();
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

  async function makeWorkspaceRun(
    runAt: number,
    label: string
  ): Promise<string> {
    const runFile = path.join(
      realRepo,
      ".ctrlyoke",
      ".runs",
      "workflow-2026-01-01T00-00-00",
      formatRunRef(runAt),
      "workflow.ctrlyoke.json"
    );
    await fs.mkdir(path.dirname(runFile), { recursive: true });
    await fs.writeFile(
      runFile,
      JSON.stringify({
        startedAt: runAt,
        definitionRevision: 1,
        steps: [{ prompt: label }],
        _runtime: {},
      })
    );
    return runFile;
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
