import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import { WorkspaceInitializer } from "../../core/orchestration/WorkspaceInitializer";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { useFakeUserHome } from "../helpers/fakeUserHome";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("WorkspaceInitializer", () => {
  const tempRoots: string[] = [];

  function createWorkspace(): string {
    const workspaceRoot = makeTempDir("cy-init-");
    tempRoots.push(workspaceRoot);
    return workspaceRoot;
  }

  teardown(() => {
    for (const workspaceRoot of tempRoots.splice(0)) {
      removeTempDir(workspaceRoot);
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
          "# This file ignores ITSELF (last line) so initialization leaves your worktree\n" +
          "# clean. Before editing it, DELETE that `.gitignore` line. Its absence marks\n" +
          "# this file as user-owned, and ctrlyoke will stop restoring removed defaults.\n" +
          "#\n" +
          "# Managed worktrees reject non-ignored untracked runtime files. They never land\n" +
          "# certs/, notifications/, temp/, or logs/, even when explicitly tracked.\n"
      )
    );
    assert.match(gitignoreContent, /^\.runs\/$/m);
    assert.match(gitignoreContent, /^\.search-index\/$/m);
    assert.match(gitignoreContent, /^logs\/$/m);
    assert.match(gitignoreContent, /^temp\/$/m);
    assert.match(gitignoreContent, /^attachments\/$/m);
    assert.match(gitignoreContent, /^prompts\/$/m);
    assert.match(gitignoreContent, /^capabilities\.json$/m);
    assert.match(gitignoreContent, /^coordination\/$/m);
    assert.match(gitignoreContent, /^execution-leases\/$/m);
    assert.strictEqual(
      gitignoreContent.trimEnd().split("\n").at(-1),
      ".gitignore"
    );
  });

  test("adds the non-Git scope storage entries to a .gitignore generated before them", async () => {
    // A folder that was not a repository keeps leases and the coordination
    // board under `.ctrlyoke/`; a later `git init` must not see them.
    const workspaceRoot = createWorkspace();
    const gitignorePath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      ".gitignore"
    );
    await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);
    const olderContent = (await fs.promises.readFile(gitignorePath, "utf8"))
      .replace("coordination/\n", "")
      .replace("execution-leases/\n", "");
    await fs.promises.writeFile(gitignorePath, olderContent, "utf8");

    await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);

    assert.strictEqual(
      (await fs.promises.readFile(gitignorePath, "utf8")).slice(
        olderContent.length
      ),
      "coordination/\nexecution-leases/\n"
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

  test("restores missing entries while the generated ownership marker remains", async () => {
    const workspaceRoot = createWorkspace();
    const ctrlyokeDir = path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    const gitignorePath = path.join(ctrlyokeDir, ".gitignore");
    await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);
    const generatedContent = await fs.promises.readFile(gitignorePath, "utf8");
    const existingContent = generatedContent
      .replace("capabilities.json\n", "")
      .replace(".gitignore\n", "custom-entry\n.gitignore\n");
    await fs.promises.writeFile(gitignorePath, existingContent, "utf8");

    await WorkspaceInitializer.reinitialize(workspaceRoot);

    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    assert.ok(gitignoreContent.startsWith(existingContent));
    assert.match(gitignoreContent, /^custom-entry$/m);
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
      "capabilities.json\n"
    );
  });

  test("preserves a pre-existing user-owned .gitignore byte-for-byte", async () => {
    const workspaceRoot = createWorkspace();
    const ctrlyokeDir = path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    const gitignorePath = path.join(ctrlyokeDir, ".gitignore");
    await fs.promises.mkdir(ctrlyokeDir, { recursive: true });
    const userContent = "custom-entry\n# user comment\nlogs/\n";
    await fs.promises.writeFile(gitignorePath, userContent, "utf8");

    await WorkspaceInitializer.reinitialize(workspaceRoot);

    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    assert.strictEqual(gitignoreContent, userContent);
  });

  test("transfers ownership when the generated self-ignore entry is deleted", async () => {
    const workspaceRoot = createWorkspace();
    await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);
    const gitignorePath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      ".gitignore"
    );
    const generatedContent = await fs.promises.readFile(gitignorePath, "utf8");
    const userContent = generatedContent
      .replace("prompts/\n", "")
      .replace(".gitignore\n", "# user-owned\n");
    await fs.promises.writeFile(gitignorePath, userContent, "utf8");

    await WorkspaceInitializer.reinitialize(workspaceRoot);

    assert.strictEqual(
      await fs.promises.readFile(gitignorePath, "utf8"),
      userContent
    );
  });

  suite("home directory workspace", () => {
    let restoreHome: (() => void) | undefined;

    teardown(() => {
      restoreHome?.();
      restoreHome = undefined;
    });

    function createHomeWorkspace(): string {
      const home = createWorkspace();
      restoreHome = useFakeUserHome(home);
      return home;
    }

    test("does not count a .ctrlyoke folder holding only user state as initialized", async () => {
      const home = createHomeWorkspace();
      fs.mkdirSync(path.join(home, PATH_CONSTANTS.CTRLYOKE_DIR));
      fs.writeFileSync(
        path.join(home, PATH_CONSTANTS.CTRLYOKE_DIR, "settings.json"),
        "{}"
      );

      assert.strictEqual(WorkspaceInitializer.isInitialized(home), false);
      assert.strictEqual(
        await WorkspaceInitializer.initializeIfNeeded(home),
        true
      );
      assert.strictEqual(WorkspaceInitializer.isInitialized(home), true);
      assert.strictEqual(
        await WorkspaceInitializer.initializeIfNeeded(home),
        false
      );
    });

    test("ignores user-only state and keeps authored files trackable", async () => {
      const home = createHomeWorkspace();
      await WorkspaceInitializer.initializeIfNeeded(home);
      const lines = fs
        .readFileSync(
          path.join(home, PATH_CONSTANTS.CTRLYOKE_DIR, ".gitignore"),
          "utf8"
        )
        .split("\n");
      const ignoreAll = lines.indexOf("/*");
      assert.ok(ignoreAll > lines.indexOf(".gitignore"));
      for (const reinclude of [
        "!/templates/",
        "!/skills/",
        "!/settings.json",
        "!/*.ctrlyoke.yaml",
        "!/*.prompt.md",
      ]) {
        assert.ok(lines.indexOf(reinclude) > ignoreAll, reinclude);
      }
    });

    test("appends the home rules to a .gitignore generated before them", async () => {
      const home = createHomeWorkspace();
      const ctrlyokeDir = path.join(home, PATH_CONSTANTS.CTRLYOKE_DIR);
      fs.mkdirSync(ctrlyokeDir);
      fs.writeFileSync(
        path.join(ctrlyokeDir, ".gitignore"),
        "# generated\n.runs/\n.gitignore\n"
      );

      assert.strictEqual(WorkspaceInitializer.isInitialized(home), true);
      await WorkspaceInitializer.initializeIfNeeded(home);
      const lines = fs
        .readFileSync(path.join(ctrlyokeDir, ".gitignore"), "utf8")
        .split("\n");
      assert.ok(lines.indexOf("/*") > lines.indexOf(".gitignore"));
      assert.ok(lines.indexOf("!/settings.json") > lines.indexOf("/*"));
    });
  });
});
