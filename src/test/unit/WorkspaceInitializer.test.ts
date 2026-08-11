import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import { WorkspaceInitializer } from "../../core/orchestration/WorkspaceInitializer";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

suite("WorkspaceInitializer", () => {
  const tempRoots: string[] = [];

  function createWorkspace(): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-init-"));
    tempRoots.push(workspaceRoot);
    return workspaceRoot;
  }

  teardown(() => {
    for (const workspaceRoot of tempRoots.splice(0)) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("creates generated .gitignore entries on first initialization", async () => {
    const workspaceRoot = createWorkspace();

    const wasInitialized =
      await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);

    assert.strictEqual(wasInitialized, true);
    const gitignorePath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      ".gitignore"
    );
    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");

    assert.ok(
      gitignoreContent.startsWith(
        "# ctrlyoke generated runtime entries are machine-local. Authored files in\n" +
          "# templates/, scripts/, agents/, skills/, mcp/, and settings.json remain trackable.\n" +
          "#\n" +
          "# This file ignores ITSELF (last line) so initializing ctrlyoke leaves your\n" +
          "# worktree clean. If you edit this file — e.g. to start tracking runs or\n" +
          "# attachments — DELETE the `.gitignore` line at the bottom first. Otherwise your\n" +
          "# changes stay on this machine and every other clone regenerates the defaults.\n"
      )
    );
    assert.match(gitignoreContent, /^\.runs\/$/m);
    assert.match(gitignoreContent, /^\.search-index\/$/m);
    assert.match(gitignoreContent, /^logs\/$/m);
    assert.match(gitignoreContent, /^temp\/$/m);
    assert.match(gitignoreContent, /^attachments\/$/m);
    assert.match(gitignoreContent, /^prompts\/$/m);
    assert.match(gitignoreContent, /^capabilities\.json$/m);
    assert.strictEqual(
      gitignoreContent.trimEnd().split("\n").at(-1),
      ".gitignore"
    );
  });

  test("creates no subdirectories — only .ctrlyoke/ and its .gitignore", async () => {
    const workspaceRoot = createWorkspace();

    await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);

    const ctrlyokeDir = path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    assert.deepStrictEqual(fs.readdirSync(ctrlyokeDir), [".gitignore"]);
  });

  test("does not create empty user-facing directories", async () => {
    const workspaceRoot = createWorkspace();

    await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);

    const ctrlyokeDir = path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    for (const dir of [
      PATH_CONSTANTS.PROMPTS_DIR,
      PATH_CONSTANTS.SCRIPTS_DIR,
      PATH_CONSTANTS.TEMPLATES_DIR,
      PATH_CONSTANTS.AGENTS_DIR,
      PATH_CONSTANTS.SKILLS_DIR,
    ]) {
      assert.strictEqual(
        fs.existsSync(path.join(ctrlyokeDir, dir)),
        false,
        `${dir}/ should be created lazily by its owning consumer, not by init`
      );
    }
  });

  test("appends missing generated .gitignore entries without removing user entries", async () => {
    const workspaceRoot = createWorkspace();
    const ctrlyokeDir = path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    const gitignorePath = path.join(ctrlyokeDir, ".gitignore");
    await fs.promises.mkdir(ctrlyokeDir, { recursive: true });
    const existingContent = "custom-entry\n# user comment\nlogs/\n";
    await fs.promises.writeFile(gitignorePath, existingContent, "utf8");

    await WorkspaceInitializer.reinitialize(workspaceRoot);

    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    assert.ok(gitignoreContent.startsWith(existingContent));
    assert.match(gitignoreContent, /^custom-entry$/m);
    assert.match(gitignoreContent, /^# user comment$/m);
    assert.strictEqual(
      gitignoreContent.match(/^logs\/$/gm)?.length,
      1,
      "existing generated entries should not be duplicated"
    );
    assert.match(gitignoreContent, /^capabilities\.json$/m);
    assert.match(gitignoreContent, /^\.search-index\/$/m);
    assert.match(gitignoreContent, /^\.gitignore$/m);
    assert.strictEqual(
      gitignoreContent.slice(existingContent.length),
      [
        ".runs/",
        ".search-index/",
        "temp/",
        "certs/",
        "notifications/",
        "capabilities.json",
        "attachments/",
        "prompts/",
        ".usage/",
        ".gitignore",
        "",
      ].join("\n")
    );
  });

  test("does not append generated header comments as entries", async () => {
    const workspaceRoot = createWorkspace();
    const ctrlyokeDir = path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    const gitignorePath = path.join(ctrlyokeDir, ".gitignore");
    await fs.promises.mkdir(ctrlyokeDir, { recursive: true });
    await fs.promises.writeFile(gitignorePath, "custom-entry\n", "utf8");

    await WorkspaceInitializer.reinitialize(workspaceRoot);

    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    assert.strictEqual(
      gitignoreContent.includes("# ctrlyoke generated runtime entries"),
      false
    );
    assert.strictEqual(
      gitignoreContent.includes("# This file ignores ITSELF"),
      false
    );
  });
});
