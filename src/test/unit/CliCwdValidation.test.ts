import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { runCli } from "../integration/helpers/cliProcess";

suite("CLI --cwd validation", () => {
  let tempRoot: string;
  let stateHome: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-cli-cwd-"));
    stateHome = path.join(tempRoot, "state");
    await fs.mkdir(stateHome);
  });

  teardown(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("rejects a missing cwd before registering project state", async () => {
    const missing = path.join(tempRoot, "missing");
    const result = await runCli(
      ["status", "--cwd", missing, "--json"],
      tempRoot,
      { CTRLYOKE_HOME: stateHome }
    );

    assert.strictEqual(result.code, 2);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      success: false,
      error: { message: `--cwd ${missing} is not a directory` },
    });
    await assert.rejects(fs.stat(path.join(stateHome, "projects")));
  });

  test("accepts an existing directory", async () => {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace);
    const result = await runCli(
      ["status", "--cwd", workspace, "--json"],
      tempRoot,
      { CTRLYOKE_HOME: stateHome }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(JSON.parse(result.stdout).workspaceRoot, workspace);
  });
});
