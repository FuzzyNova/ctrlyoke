import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { runCli } from "./helpers/cliProcess";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

/**
 * Running a workflow is an explicit choice to use ctrlyoke in a folder, so
 * it initializes the workspace without asking. Commands that only read or
 * review must leave a folder ctrlyoke has never initialized untouched:
 * `.ctrlyoke/` existing is what makes VS Code treat the folder as initialized.
 */
suite("CLI workspace initialization", function () {
  this.timeout(30000);

  let root: string;
  let workspace: string;
  let env: NodeJS.ProcessEnv;

  setup(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-cli-init-"));
    workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    env = { CTRLYOKE_HOME: path.join(root, "state-home") };
  });

  teardown(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeWorkflow(): Promise<string> {
    const file = path.join(workspace, "check.ctrlyoke.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        steps: [{ type: "script", script: 'node -e "process.exit(0)"' }],
      })
    );
    return file;
  }

  async function ctrlyokeDirEntries(): Promise<string[] | undefined> {
    try {
      return await fs.readdir(
        path.join(workspace, PATH_CONSTANTS.CTRLYOKE_DIR),
        { recursive: true }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  test("read-only and review commands create no .ctrlyoke directory", async () => {
    const workflow = await writeWorkflow();

    const validate = await runCli(["validate", workflow], workspace, env);
    assert.strictEqual(validate.code, 0, validate.stderr);
    const review = await runCli(
      ["trust-external-roots", "--cwd", workspace],
      workspace,
      env
    );
    assert.strictEqual(review.code, 0, review.stderr);

    const created = await ctrlyokeDirEntries();
    assert.strictEqual(
      created,
      undefined,
      `.ctrlyoke/ was created, containing: ${JSON.stringify(created)}`
    );
  });

  test("run initializes the workspace, .gitignore included", async () => {
    const workflow = await writeWorkflow();

    const result = await runCli(
      ["run", workflow, "--dry-run", "--json", "--cwd", workspace],
      workspace,
      env
    );
    assert.strictEqual(result.code, 0, result.stderr);

    const created = (await ctrlyokeDirEntries()) ?? [];
    assert.ok(created.includes(".gitignore"), JSON.stringify(created));
    assert.ok(
      created.some((entry) =>
        entry.startsWith(`${PATH_CONSTANTS.LOGS_DIR}${path.sep}`)
      ),
      `run should log into the workspace it initialized: ${JSON.stringify(created)}`
    );
  });
});
