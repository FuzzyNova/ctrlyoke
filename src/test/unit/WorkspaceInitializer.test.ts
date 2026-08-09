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

    assert.match(gitignoreContent, /^\.runs\/$/m);
    assert.match(gitignoreContent, /^\.search-index\/$/m);
    assert.match(gitignoreContent, /^logs\/$/m);
    assert.match(gitignoreContent, /^temp\/$/m);
    assert.match(gitignoreContent, /^capabilities\.json$/m);
    assert.match(gitignoreContent, /^\.gitignore$/m);
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
    await fs.promises.writeFile(gitignorePath, "custom-entry\nlogs/\n", "utf8");

    await WorkspaceInitializer.reinitialize(workspaceRoot);

    const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    assert.match(gitignoreContent, /^custom-entry$/m);
    assert.strictEqual(
      gitignoreContent.match(/^logs\/$/gm)?.length,
      1,
      "existing generated entries should not be duplicated"
    );
    assert.match(gitignoreContent, /^capabilities\.json$/m);
    assert.match(gitignoreContent, /^\.search-index\/$/m);
    assert.match(gitignoreContent, /^\.gitignore$/m);
  });
});
