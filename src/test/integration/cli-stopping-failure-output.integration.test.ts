import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import { runCli } from "./helpers/cliProcess";

const temporaryRoots: string[] = [];

suite("CLI stopping failure output", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("keeps harness failure reasons on stderr and in the JSON error", async function () {
    this.timeout(120000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-cli-failure-"));
    temporaryRoots.push(root);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    const failure = "Harness deliberately failed";
    if (process.platform === "win32") {
      await fs.writeFile(path.join(bin, "copilot.cmd"), `@echo off\r\nif /i "%~1"=="--version" (echo fake version&exit /b 0)\r\necho ${failure} 1>&2\r\nexit /b 1\r\n`, "utf8");
    } else {
      const executable = path.join(bin, "copilot");
      await fs.writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'fake version'; exit 0; fi\necho '${failure}' >&2\nexit 1\n`, "utf8");
      await fs.chmod(executable, 0o755);
    }
    const workflow = path.join(root, "workflow.ctrlyoke.json");
    await fs.writeFile(workflow, JSON.stringify({ steps: [{ prompt: "run" }] }), "utf8");
    const env = { CTRLYOKE_HOME: path.join(root, "state"), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };

    for (const extraArgs of [[], ["--json"]]) {
      const result = await runCli(["run", workflow, "--headless", "--harness", "copilot-cli", "--cwd", root, ...extraArgs], root, env);
      assert.notStrictEqual(result.code, 0, result.stdout);
      assert.match(result.stderr, /Harness deliberately failed/u, JSON.stringify(result));
      if (extraArgs.includes("--json")) {
        assert.match(JSON.parse(result.stdout).error.message, /Harness deliberately failed/u);
      }
    }
  });

  test("keeps queue guardrail reasons on stderr and in the JSON error", async function () {
    this.timeout(120000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-cli-limit-"));
    temporaryRoots.push(root);
    const workflow = path.join(root, "workflow.ctrlyoke.json");
    await fs.writeFile(workflow, JSON.stringify({
      maxSteps: 2,
      steps: [
        { type: "script", script: 'node -e "process.exit(0)"' },
        { type: "script", script: 'node -e "process.exit(0)"' },
        { type: "script", script: 'node -e "process.exit(0)"' },
      ],
    }), "utf8");
    const env = { CTRLYOKE_HOME: path.join(root, "state") };
    for (const extraArgs of [[], ["--json"]]) {
      const result = await runCli(["run", workflow, "--headless", "--cwd", root, ...extraArgs], root, env);
      assert.strictEqual(result.code, 6, result.stderr);
      assert.match(result.stderr, /Step limit reached: this run has 3\/2 steps/u);
      if (extraArgs.includes("--json")) {
        assert.match(JSON.parse(result.stdout).error.message, /Step limit reached: this run has 3\/2 steps/u);
      }
    }
  });
});
