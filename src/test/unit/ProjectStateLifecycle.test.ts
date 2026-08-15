import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { ProjectStateRegistry } from "../../utils/ProjectStateRegistry";
import {
  inspectUserProjects,
  relinkUserProject,
  ProjectStateLifecycleError,
} from "../../utils/ProjectStateLifecycle";
import { projectStateRoot } from "../../utils/ProjectStatePaths";
import { RUN_HISTORY_LOCATIONS } from "../../types/DashboardConstants";
import {
  pruneHistoryCommand,
  relinkHistoryCommand,
  type HistoryCommandIo,
} from "../../cli/HistoryCommands";

suite("ProjectStateLifecycle", () => {
  let stateHome: string;
  let originalStateHome: string | undefined;

  setup(async () => {
    originalStateHome = process.env.CTRLYOKE_HOME;
    stateHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-history-lifecycle-")
    );
    process.env.CTRLYOKE_HOME = stateHome;
  });

  teardown(async () => {
    if (originalStateHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = originalStateHome;
    }
    await fs.rm(stateHome, { recursive: true, force: true });
  });

  test("prune defaults to a dry-run and --yes deletes only orphaned projects", async () => {
    const orphan = await makeProject("orphan");
    await fs.rm(orphan.stateRoot, { recursive: true, force: true });

    const output: string[] = [];
    const io = makeIo(output, false);
    await pruneHistoryCommand({}, io);
    assert.ok(output.some((line) => line.includes("ORPHAN")));
    assert.ok(await fs.stat(orphan.projectRoot));

    await pruneHistoryCommand({ yes: true }, io);
    await assert.rejects(() => fs.stat(orphan.projectRoot), { code: "ENOENT" });
  });

  test("prune classifies inaccessible state paths as unknown", async () => {
    const project = await makeProject("inaccessible");
    const blocker = path.join(stateHome, "not-a-directory");
    await fs.writeFile(blocker, "file");
    await fs.writeFile(
      path.join(project.projectRoot, "project.json"),
      JSON.stringify({
        schemaVersion: 1,
        statePath: path.join(blocker, "child"),
        createdAt: project.createdAt,
        lastOpenedAt: new Date().toISOString(),
      })
    );

    const inspections = await inspectUserProjects();
    assert.strictEqual(inspections[0]?.statePathStatus, "unknown");
    const output: string[] = [];
    await pruneHistoryCommand({ yes: true }, makeIo(output, false));
    assert.ok(await fs.stat(project.projectRoot));
    assert.ok(output.some((line) => line.includes("UNKNOWN")));
  });

  test("prune refuses a project containing a live runner", async () => {
    const project = await makeProject("running");
    await fs.rm(project.stateRoot, { recursive: true, force: true });
    const lineage = path.join(project.projectRoot, ".runs", "workflow");
    await fs.mkdir(lineage, { recursive: true });
    await fs.writeFile(
      path.join(lineage, "runner.json"),
      JSON.stringify({ pid: process.pid, lastHeartbeat: Date.now() })
    );

    const output: string[] = [];
    await pruneHistoryCommand({ yes: true }, makeIo(output, false));
    assert.ok(await fs.stat(project.projectRoot));
    assert.ok(output.some((line) => line.includes("REFUSED")));
  });

  test("relink dry-run is gated and does not replace a destination", async () => {
    const oldProject = await makeProject("old");
    const newRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-new-"));
    const output: string[] = [];
    await relinkHistoryCommand(
      oldProject.stateRoot,
      newRoot,
      {},
      makeIo(output, false)
    );
    assert.ok(output.some((line) => line.includes("Would relink")));
    assert.ok(await fs.stat(oldProject.projectRoot));

    await relinkHistoryCommand(
      oldProject.stateRoot,
      newRoot,
      { yes: true },
      makeIo(output, false)
    );
    await assert.rejects(() => fs.stat(oldProject.projectRoot), {
      code: "ENOENT",
    });
    await fs.rm(newRoot, { recursive: true, force: true });
  });

  test("relink refuses live source and destination runners", async () => {
    const oldProject = await makeProject("live-source");
    const newRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-dest-"));
    const sourceLineage = path.join(
      oldProject.projectRoot,
      ".runs",
      "workflow"
    );
    await fs.mkdir(sourceLineage, { recursive: true });
    await fs.writeFile(
      path.join(sourceLineage, "runner.json"),
      JSON.stringify({ pid: process.pid, lastHeartbeat: Date.now() })
    );
    await assert.rejects(
      () => relinkUserProject(oldProject.stateRoot, newRoot, { dryRun: false }),
      (error: unknown) =>
        error instanceof ProjectStateLifecycleError &&
        error.message.includes("live runner")
    );

    await fs.rm(path.join(sourceLineage, "runner.json"));
    const destination = await makeProject("live-destination", newRoot);
    const destinationLineage = path.join(
      destination.projectRoot,
      ".runs",
      "workflow"
    );
    await fs.mkdir(destinationLineage, { recursive: true });
    await fs.writeFile(
      path.join(destinationLineage, "runner.json"),
      JSON.stringify({ pid: process.pid, lastHeartbeat: Date.now() })
    );
    await assert.rejects(
      () => relinkUserProject(oldProject.stateRoot, newRoot, { dryRun: false }),
      (error: unknown) =>
        error instanceof ProjectStateLifecycleError &&
        error.message.includes("destination")
    );
    await fs.rm(newRoot, { recursive: true, force: true });
  });

  test("relink refuses a destination containing real history", async () => {
    const oldProject = await makeProject("collision-source");
    const newRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-collision-")
    );
    const destination = await makeProject("collision-destination", newRoot);
    await fs.mkdir(
      path.join(destination.projectRoot, ".runs", "real-history"),
      {
        recursive: true,
      }
    );

    await assert.rejects(
      () => relinkUserProject(oldProject.stateRoot, newRoot, { dryRun: true }),
      /contains history or other data/
    );
    await fs.rm(newRoot, { recursive: true, force: true });
  });

  test("relink replaces an empty scaffold and preserves createdAt", async () => {
    const oldProject = await makeProject("preserve-created-at");
    const newRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-scaffold-")
    );
    await makeProject("destination-scaffold", newRoot);
    const originalCreatedAt = oldProject.createdAt;

    const result = await relinkUserProject(oldProject.stateRoot, newRoot, {
      dryRun: false,
      gitToplevel: null,
    });
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(result.newProjectRoot, "project.json"),
        "utf8"
      )
    ) as Record<string, string>;

    assert.strictEqual(result.replacedEmptyScaffold, true);
    assert.strictEqual(metadata.createdAt, originalCreatedAt);
    assert.strictEqual(metadata.statePath, path.resolve(newRoot));
    assert.strictEqual(metadata.gitToplevel, undefined);
    assert.notStrictEqual(metadata.lastOpenedAt, originalCreatedAt);
    await fs.rm(newRoot, { recursive: true, force: true });
  });

  async function makeProject(
    name: string,
    stateRoot = path.join(stateHome, name)
  ): Promise<{ stateRoot: string; projectRoot: string; createdAt: string }> {
    await fs.mkdir(stateRoot, { recursive: true });
    const initialized = await new ProjectStateRegistry(
      RUN_HISTORY_LOCATIONS.USER
    ).initialize(stateRoot, stateRoot);
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(initialized.projectRoot, "project.json"),
        "utf8"
      )
    ) as { createdAt: string };
    return {
      stateRoot,
      projectRoot: projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.USER),
      createdAt: metadata.createdAt,
    };
  }

  function makeIo(output: string[], isInteractive: boolean): HistoryCommandIo {
    return {
      writeOut: (message) => output.push(message),
      writeErr: (message) => output.push(message),
      isInteractive,
      confirm: async () => true,
    };
  }
});
