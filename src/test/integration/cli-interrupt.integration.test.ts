import * as assert from "assert";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";

const temporaryRoots: string[] = [];

async function interruptRun(
  json: boolean,
  beforeStepStarts = false
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  root: string;
  startMarker: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-cli-interrupt-"));
  temporaryRoots.push(root);
  const workflowPath = path.join(root, "workflow.ctrlyoke.yaml");
  const startMarker = path.join(root, "step-started").replace(/\\/gu, "/");
  const script = `node -e "require('fs').writeFileSync('${startMarker}','started'); setTimeout(() => {}, 20000)"`;
  await fs.writeFile(
    workflowPath,
    `name: interrupted workflow\nsteps:\n  - type: script\n    script: ${JSON.stringify(script)}\n`,
    "utf8"
  );
  const cliPath = path.join(__dirname, "..", "..", "cli.js");
  const child = spawn(
    "node",
    [cliPath, "run", workflowPath, "--headless", "--cwd", root, ...(json ? ["--json"] : [])],
    {
      cwd: root,
      env: {
        ...process.env,
        CTRLYOKE_HOME: path.join(root, "state"),
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  let signalSent = false;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (
      beforeStepStarts &&
      !signalSent &&
      stdout.includes("Running:")
    ) {
      signalSent = true;
      child.kill("SIGINT");
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  const startedAt = Date.now();
  while (beforeStepStarts ? !signalSent : true) {
    if (child.exitCode !== null) {
      throw new Error(`CLI exited before script started (${child.exitCode}): ${stderr}`);
    }
    if (!beforeStepStarts) {
      try {
        await fs.access(startMarker);
        break;
      } catch {
        // Poll until the running script creates its start marker.
      }
    }
    if (Date.now() - startedAt > (beforeStepStarts ? 10_000 : 30_000)) {
      child.kill("SIGKILL");
      throw new Error(`Timed out waiting for script start: ${stdout}\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (!beforeStepStarts) child.kill("SIGINT");
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit after SIGINT: ${stdout}\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
        root,
        startMarker,
      });
    });
  });
}

suite("CLI interrupted run", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("text mode exits with the interrupted code after printing the summary", async function () {
    this.timeout(60_000);
    const result = await interruptRun(false);
    assert.strictEqual(result.code, 5, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Workflow ended: stopped/u);
  });

  test("JSON mode prints the stopped run result before exiting with the interrupted code", async function () {
    this.timeout(60_000);
    const result = await interruptRun(true);
    assert.strictEqual(result.code, 5, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/u);
    const output = JSON.parse(lines[lines.length - 1]) as {
      workflowKey?: string;
      runRef?: string;
      status?: string;
    };
    assert.ok(output.workflowKey);
    assert.ok(output.runRef);
    assert.strictEqual(output.status, "stopped");
  });

  test("interrupting at the run header prevents the first step from starting", async function () {
    this.timeout(45_000);
    const result = await interruptRun(false, true);
    assert.strictEqual(result.code, 5, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Running:/u);
    assert.ok(result.elapsedMs < 5000, `exit took ${result.elapsedMs}ms`);
    assert.strictEqual(
      await fs
        .access(result.startMarker)
        .then(() => true)
        .catch(() => false),
      false,
      "script start marker should not exist"
    );
    const runFiles: string[] = [];
    async function collect(directory: string): Promise<void> {
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(entryPath);
        else if (entry.name === "workflow.ctrlyoke.json") runFiles.push(entryPath);
      }
    }
    await collect(result.root);
    for (const runFile of runFiles) {
      const workflow = JSON.parse(await fs.readFile(runFile, "utf8")) as {
        _runtime?: { executionState?: string };
      };
      assert.notStrictEqual(workflow._runtime?.executionState, "running", runFile);
    }
  });
});
