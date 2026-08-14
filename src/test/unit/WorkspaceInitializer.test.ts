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
});
