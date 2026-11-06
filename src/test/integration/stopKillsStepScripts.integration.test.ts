import { suite, test, setup, teardown } from "mocha";
import * as assert from "assert";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { EXECUTION_STATES, STEP_STATUS } from "../../types/DashboardConstants";
import {
  createExecutionHarness,
  type ExecutionHarness,
} from "./helpers/executionHarness";

const execFileAsync = promisify(execFile);

/**
 * Stop is the escape hatch for "stop this now" and "I clicked Run too
 * early", so it must kill whatever the current step is running: a
 * pre-condition, a headless script step, and the worktree `setup` command
 * that runs before any step is dispatched. Each case runs a real script that
 * records its PID and then hangs far longer than the test budget, presses
 * Stop once it is running, and checks the process is gone and the run is
 * STOPPED well before the hang could have ended on its own.
 */

/** Far longer than any assertion below waits: only a kill ends it early. */
const HANG_MS = 300_000;
/**
 * How long after Stop the script process may still be alive. A kill is
 * near-instant; the margin covers process-tree teardown on a loaded host.
 */
const KILL_BUDGET_MS = 5_000;

function hangScriptSource(pidFile: string): string {
  return [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `setTimeout(() => {}, ${HANG_MS});`,
    "",
  ].join("\n");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

suite("Stop kills the current step's running scripts", function () {
  // Each case spawns node (and, for setup, git) under a loaded test host.
  this.timeout(90_000);

  let workspace: string;
  let harness: ExecutionHarness | undefined;
  let spawnedPid: number | undefined;

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-stopkill-"));
    spawnedPid = undefined;
  });

  teardown(async () => {
    if (spawnedPid !== undefined && isAlive(spawnedPid)) {
      process.kill(spawnedPid);
    }
    await harness?.dispose();
    harness = undefined;
    // Managed worktrees are created beside the checkout, in
    // `<workspace>.worktrees`, so that directory is ours to remove too.
    for (const dir of [workspace, `${workspace}.worktrees`]) {
      await fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 30,
        retryDelay: 100,
      });
    }
  });

  async function writeHangScript(name: string): Promise<string> {
    const pidFile = path.join(workspace, `${name}.pid`);
    await fs.writeFile(
      path.join(workspace, `${name}.js`),
      hangScriptSource(pidFile)
    );
    return pidFile;
  }

  async function writeWorkflow(
    definition: Record<string, unknown>
  ): Promise<string> {
    const filePath = path.join(workspace, "wf.ctrlyoke.json");
    await fs.writeFile(filePath, JSON.stringify(definition, null, 2));
    return filePath;
  }

  /**
   * Start the run, wait until the script has recorded its PID, press Stop,
   * and assert the process tree died and the run settled promptly.
   */
  async function stopOnceRunning(pidFile: string): Promise<void> {
    const instance = harness!.instance;
    const run = instance.executeLoadedPromptFile();
    const pid = await waitFor(
      async () => {
        const text = await fs.readFile(pidFile, "utf8").catch(() => "");
        return text.trim() ? Number(text.trim()) : undefined;
      },
      30_000,
      "the hanging script to start"
    );
    spawnedPid = pid;
    assert.ok(isAlive(pid), "the script must be running before Stop");

    // Measured from the Stop press, not from stop() resolving: stop() can
    // also wait for the harness integration to report its turn over, which
    // the mock integration never does without a prompt in flight (the real
    // CliIntegration reports it at once), so stop() falls back to its 10 s
    // settle timeout here. The kill itself must be immediate.
    const stopping = instance.stop();
    await waitFor(
      async () => (isAlive(pid) ? undefined : true),
      KILL_BUDGET_MS,
      `script process ${pid} to be killed by Stop`
    );
    await stopping;
    await run;
    assert.strictEqual(
      instance.promptQueue.getState().status,
      EXECUTION_STATES.STOPPED
    );
    assert.deepStrictEqual(
      harness!.integration.sentPrompts,
      [],
      "the stopped step's prompt must never reach the harness"
    );
  }

  test("kills a running pre-condition", async () => {
    const pidFile = await writeHangScript("pre");
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        steps: [{ prompt: "gated", preCondition: { script: "pre.js" } }],
      })
    );

    await stopOnceRunning(pidFile);
  });

  test("kills a running headless script step", async () => {
    const pidFile = await writeHangScript("step");
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        steps: [
          { type: "script", script: "step.js", executionMode: "headless" },
          { prompt: "after the script" },
        ],
      })
    );

    await stopOnceRunning(pidFile);
  });

  test("kills a running worktree setup and leaves the never-run step pending", async () => {
    const git = (...args: string[]) =>
      execFileAsync("git", args, { cwd: workspace });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "ctrlyoke test");
    await fs.writeFile(path.join(workspace, ".gitignore"), "*.pid\n");
    const pidFile = await writeHangScript("setup");
    const setupScript = path.join(workspace, "setup.js").replace(/\\/g, "/");
    const workflowFile = await writeWorkflow({
      worktree: { mode: "managed", setup: `node "${setupScript}"` },
      steps: [{ prompt: "after setup" }],
    });
    await git("add", "-A");
    await git("commit", "-q", "-m", "init");

    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(workflowFile);

    await stopOnceRunning(pidFile);
    assert.strictEqual(
      harness.instance.promptQueue.getState().currentIndex,
      0,
      "a step that never ran must not be skipped by the stop"
    );
    assert.strictEqual(
      harness.instance.promptQueue.getState().results[0].status,
      STEP_STATUS.PENDING
    );
  });
});
