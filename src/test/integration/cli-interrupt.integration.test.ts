import * as assert from "assert";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";

const temporaryRoots: string[] = [];

async function interruptRun(
  json: boolean,
  beforeStepStarts = false,
  delayBeforeWaitMs = 0
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  root: string;
  startMarker: string;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ctrlyoke-cli-interrupt-")
  );
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
    [
      cliPath,
      "run",
      workflowPath,
      "--headless",
      "--cwd",
      root,
      ...(json ? ["--json"] : []),
    ],
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
  const startedAt = Date.now();
  // Observe exit and close from spawn time. A header interrupt can finish the
  // whole run within one poll interval, and a `close` listener attached after
  // the event has fired never runs, which looks exactly like a hung CLI.
  let exited: { code: number | null; signal: string | null } | undefined;
  let closedAt: number | undefined;
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exited = { code, signal };
    });
    child.once("close", (code) => {
      closedAt = Date.now();
      resolve(code);
    });
  });
  closed.catch(() => undefined);
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (beforeStepStarts && !signalSent && stdout.includes("Running:")) {
      signalSent = true;
      child.kill("SIGINT");
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  const markerExists = (): Promise<boolean> =>
    fs
      .access(startMarker)
      .then(() => true)
      .catch(() => false);

  while (beforeStepStarts ? !signalSent : true) {
    if (closedAt !== undefined || exited) {
      throw new Error(
        `CLI exited before ${beforeStepStarts ? "the run header" : "script started"} (${exited?.code}): ${stderr}`
      );
    }
    if (!beforeStepStarts && (await markerExists())) break;
    if (Date.now() - startedAt > (beforeStepStarts ? 10_000 : 30_000)) {
      child.kill("SIGKILL");
      throw new Error(
        `Timed out waiting for script start: ${stdout}\n${stderr}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (!beforeStepStarts) child.kill("SIGINT");
  if (delayBeforeWaitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayBeforeWaitMs));
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    closed,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        void (async () => {
          // Name what is still alive: an `exit` without `close` means a
          // descendant holds the inherited pipes; no `exit` means the CLI
          // itself is still running.
          const diagnostics = [
            `exit event: ${exited ? JSON.stringify(exited) : "not seen"}`,
            `child.exitCode=${child.exitCode} child.signalCode=${child.signalCode}`,
            `step-started marker exists: ${await markerExists()}`,
          ].join("; ");
          child.kill("SIGKILL");
          reject(
            new Error(
              `CLI did not exit after SIGINT (${diagnostics}): ${stdout}\n${stderr}`
            )
          );
        })();
      }, 30_000);
    }),
  ]).finally(() => clearTimeout(timeout));
  return {
    code: code ?? 1,
    stdout,
    stderr,
    elapsedMs: (closedAt ?? Date.now()) - startedAt,
    root,
    startMarker,
  };
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
    // Start waiting only after the CLI has normally finished: the helper must
    // still see an exit that happened before it looked.
    const result = await interruptRun(false, true, 1000);
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
      for (const entry of await fs
        .readdir(directory, { withFileTypes: true })
        .catch(() => [])) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(entryPath);
        else if (entry.name === "workflow.ctrlyoke.json")
          runFiles.push(entryPath);
      }
    }
    await collect(result.root);
    for (const runFile of runFiles) {
      const workflow = JSON.parse(await fs.readFile(runFile, "utf8")) as {
        _runtime?: { executionState?: string };
      };
      assert.notStrictEqual(
        workflow._runtime?.executionState,
        "running",
        runFile
      );
    }
  });
});
