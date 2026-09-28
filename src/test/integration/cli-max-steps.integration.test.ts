import * as assert from "assert";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const temporaryRoots: string[] = [];

function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<CliResult> {
  const cliPath = path.join(__dirname, "..", "..", "cli.js");
  return new Promise((resolve) => {
    execFile(
      "node",
      [cliPath, ...args],
      { cwd, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        });
      }
    );
  });
}

suite("CLI maxSteps append enforcement", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects CLI append at the workflow maxSteps cap", async function () {
    this.timeout(60_000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-cli-cap-"));
    temporaryRoots.push(root);
    const stateHome = path.join(root, "state");
    const workflowPath = path.join(root, "workflow.ctrlyoke.json");
    const env = { CTRLYOKE_HOME: stateHome };
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        maxSteps: 1,
        steps: [
          {
            type: "script",
            name: "noop",
            script: 'node -e "process.exit(0)"',
          },
        ],
      }),
      "utf8"
    );

    const initialRun = await runCli(
      ["run", workflowPath, "--headless", "--json", "--cwd", root],
      root,
      env
    );
    assert.strictEqual(initialRun.code, 0, initialRun.stderr);
    const run = JSON.parse(initialRun.stdout) as {
      workflowKey: string;
      runRef: string;
    };

    const append = await runCli(
      [
        "append",
        "--workflow",
        run.workflowKey,
        "--run",
        run.runRef,
        "--prompt",
        "over cap",
        "--headless",
        "--json",
        "--cwd",
        root,
      ],
      root,
      env
    );

    assert.strictEqual(append.code, 2);
    assert.match(
      JSON.parse(append.stdout).error.message,
      /Step limit reached: this run has 1\/1 steps \(workflow maxSteps: 1\)/
    );
  });
});
