import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { runCli } from "./helpers/cliProcess";

const temporaryRoots: string[] = [];

// An interactive run used to install no output subscriptions at all, so every
// step that was not an interactive TUI (headless steps, scripts, verdicts,
// status lines) ran in silence.
suite("CLI interactive run output", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("prints the output and verdicts of steps that are not interactive", async function () {
    this.timeout(60_000);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-interactive-")
    );
    temporaryRoots.push(root);
    const workflowPath = path.join(root, "workflow.ctrlyoke.json");
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        steps: [
          {
            type: "script",
            name: "greet",
            script: "node -e \"console.log('hello from the script step')\"",
          },
        ],
      }),
      "utf8"
    );

    const result = await runCli(
      ["run", workflowPath, "--interactive", "--cwd", root],
      root,
      { CTRLYOKE_HOME: path.join(root, "state") }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /hello from the script step/);
    assert.match(result.stdout, /greet/);
  });
});
