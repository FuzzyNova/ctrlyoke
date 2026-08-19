import { suite, test, setup, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  ACTION_TYPES,
  CONDITION_ACTIONS,
  EXECUTION_PHASES,
  EXECUTION_STATES,
  SCRIPT_OUTPUT_SOURCES,
} from "../../types/DashboardConstants";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import {
  createExecutionHarness,
  type ExecutionHarness,
} from "./helpers/executionHarness";
import { configService } from "../../config/CtrlYokeConfigService";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

/**
 * Full user-flow coverage for workflow-level `preCondition`: load a workflow
 * (or set the property after load, as the dashboard does), press Run, and
 * verify the gate script actually executes before the first prompt and its
 * onPass/onFail action is honored.
 *
 * The whole production pipeline runs — parse, draft, run promotion, executor
 * loop, EndConditionEvaluator — against a real temp workspace; only the AI
 * harness is a recording no-op mock (see `helpers/executionHarness.ts`).
 * The pre-condition scripts leave a marker file, so "did the gate run?" is a
 * plain filesystem assertion and "was the prompt skipped?" is
 * `integration.sentPrompts`.
 */

const MARKER_FILE = "pre-ran.txt";
const END_MARKER_FILE = "end-ran.txt";
const PASSING_SCRIPT = "pre-pass.js";
const PASSING_END_SCRIPT = "end-pass.js";
const FAILING_SCRIPT = "pre-fail.js";
const ERROR_SCRIPT = "pre-error.txt";
const RETRY_GATE_SCRIPT = "pre-retry.js";
const SHARED_BUDGET_GATE_SCRIPT = "pre-shared-budget.js";
const WRITE_MARKER = `require('fs').writeFileSync(require('path').join(__dirname, '${MARKER_FILE}'), 'ran');`;
const APPEND_MARKER = `const fs = require('fs'); const p = require('path').join(__dirname, '${MARKER_FILE}'); const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').length : 0; fs.appendFileSync(p, 'x');`;

suite("Workflow-level preCondition full flow (load -> run)", function () {
  // Each test executes a full workflow incl. a node subprocess for the gate.
  this.timeout(60_000);

  let workspace: string;
  let harness: ExecutionHarness | undefined;

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-precond-"));
    await fs.writeFile(
      path.join(workspace, PASSING_SCRIPT),
      `${WRITE_MARKER}\n`
    );
    await fs.writeFile(
      path.join(workspace, PASSING_END_SCRIPT),
      `require('fs').writeFileSync(require('path').join(__dirname, '${END_MARKER_FILE}'), 'ran');\n`
    );
    await fs.writeFile(
      path.join(workspace, FAILING_SCRIPT),
      `${WRITE_MARKER}\nprocess.exit(1);\n`
    );
    await fs.writeFile(path.join(workspace, ERROR_SCRIPT), "not executable\n");
    await fs.writeFile(
      path.join(workspace, RETRY_GATE_SCRIPT),
      // The hang must outlast the gate timeout by a wide margin: the retry
      // attempt has to spawn a real `node` process and exit inside that same
      // timeout, and process startup alone can cost >100ms on a loaded machine.
      `${APPEND_MARKER}\nif (before === 0) setTimeout(() => {}, 3000);\n`
    );
    await fs.writeFile(
      path.join(workspace, SHARED_BUDGET_GATE_SCRIPT),
      `${APPEND_MARKER}\nif (before === 1) setTimeout(() => {}, 2000);\n`
    );
  });

  teardown(async () => {
    configService.setCliOverlay({});
    await harness?.dispose();
    harness = undefined;
    await fs.rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 30,
      retryDelay: 100,
    });
  });

  async function writeWorkflow(
    definition: Record<string, unknown>
  ): Promise<string> {
    const filePath = path.join(workspace, "wf.ctrlyoke.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({ steps: [{ prompt: "step 1" }], ...definition }, null, 2)
    );
    return filePath;
  }

  async function markerExists(): Promise<boolean> {
    try {
      await fs.access(path.join(workspace, MARKER_FILE));
      return true;
    } catch {
      return false;
    }
  }

  async function markerLength(): Promise<number> {
    try {
      return (await fs.readFile(path.join(workspace, MARKER_FILE), "utf8"))
        .length;
    } catch {
      return 0;
    }
  }

  async function findFiles(root: string, fileName: string): Promise<string[]> {
    const matches: string[] = [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        matches.push(...(await findFiles(entryPath, fileName)));
      } else if (entry.name === fileName) {
        matches.push(entryPath);
      }
    }
    return matches;
  }

  test("control: without a preCondition the prompt reaches the harness", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(await writeWorkflow({}));
    await harness.instance.executeLoadedPromptFile();

    assert.deepStrictEqual(
      harness.integration.sentPrompts,
      ["step 1"],
      "the mock harness must receive the prompt when no gate is configured"
    );
    assert.strictEqual(await markerExists(), false);
  });

  test("reports a failed source parse to the caller", async () => {
    harness = createExecutionHarness(workspace);
    const invalidWorkflow = path.join(workspace, "invalid.ctrlyoke.json");
    await fs.writeFile(invalidWorkflow, "{ invalid json");

    assert.strictEqual(
      await harness.instance.loadPromptFile(invalidWorkflow),
      false
    );
  });

  test("workflow-level preCondition in the source file runs before the first prompt; onPass: skipPrompt skips it", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: {
          script: PASSING_SCRIPT,
          onPass: CONDITION_ACTIONS.SKIP_PROMPT,
        },
      })
    );
    await harness.instance.executeLoadedPromptFile();

    assert.strictEqual(
      await markerExists(),
      true,
      "workflow-level preCondition script must run before the first prompt"
    );
    assert.deepStrictEqual(
      harness.integration.sentPrompts,
      [],
      "onPass: skipPrompt must skip the prompt (it must never reach the harness)"
    );
    assert.strictEqual(
      harness.instance.promptQueue.getState().status,
      EXECUTION_STATES.COMPLETED,
      "an all-skipped workflow must still complete cleanly"
    );
  });

  test("preCondition set via property update after load gates the first prompt", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(await writeWorkflow({}));
    // The dashboard property-edit path: workflow already loaded, user sets the
    // pre-condition, then presses Run.
    await harness.instance.updateWorkingFileProperties({
      preCondition: {
        script: PASSING_SCRIPT,
        onPass: CONDITION_ACTIONS.SKIP_PROMPT,
      },
    });
    await harness.instance.executeLoadedPromptFile();

    assert.strictEqual(
      await markerExists(),
      true,
      "a preCondition added after load must run before the first prompt"
    );
    assert.deepStrictEqual(harness.integration.sentPrompts, []);
  });

  test("failing preCondition defaults to skipPrompt", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: { script: FAILING_SCRIPT },
      })
    );
    await harness.instance.executeLoadedPromptFile();

    assert.strictEqual(await markerExists(), true, "gate script must run");
    assert.deepStrictEqual(
      harness.integration.sentPrompts,
      [],
      "a failing preCondition must skip the prompt by default"
    );
  });

  test("passing preCondition with default onPass continues into the prompt", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: { script: PASSING_SCRIPT },
      })
    );
    await harness.instance.executeLoadedPromptFile();

    assert.strictEqual(await markerExists(), true, "gate script must run");
    assert.deepStrictEqual(
      harness.integration.sentPrompts,
      ["step 1"],
      "default onPass is continue — the prompt must still execute"
    );

    const eventsPath = (
      await findFiles(WorkflowPaths.runsRoot(workspace), "events.jsonl")
    )[0];
    assert.ok(eventsPath, "the run must persist a timeline");
    const cliEntries = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        (event) => event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED
      )
      .map((event) => ({
        ...event.payload.cliOutput,
        phase: event.phase,
      }))
      .filter((output) => !output.isStreaming);
    const preOutput = cliEntries.find(
      (output) => output.source === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
    );
    const promptOutput = cliEntries.find(
      (output) => output.prompt === "step 1" && output.source === undefined
    );
    assert.ok(preOutput, "the pre-condition must have its own CLI entry");
    assert.strictEqual(preOutput.phase, EXECUTION_PHASES.PRE_CONDITION);
    assert.ok(promptOutput, "the prompt must retain its own CLI entry");
    assert.strictEqual(promptOutput.phase, undefined);
    assert.notStrictEqual(preOutput, promptOutput);
    // The output pane sorts by timestamp, so a prompt stamped with the
    // whole-step attempt start would render above the gate that produced it.
    assert.ok(
      promptOutput.timestampMs > preOutput.timestampMs,
      `the prompt output must be stamped after the pre-condition that gated it (pre=${preOutput.timestampMs}, prompt=${promptOutput.timestampMs})`
    );
  });

  test("errored preCondition with onError stop halts before the prompt", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: {
          script: ERROR_SCRIPT,
        },
        errorBehavior: { onError: "stop" },
      })
    );
    await harness.instance.executeLoadedPromptFile();

    assert.deepStrictEqual(harness.integration.sentPrompts, []);
    assert.strictEqual(
      harness.instance.promptQueue.getState().status,
      EXECUTION_STATES.ERROR
    );
  });

  test("errored preCondition with onError retry re-runs the gate before the prompt", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: {
          script: RETRY_GATE_SCRIPT,
          timeout: 500,
        },
        errorBehavior: { onError: "retry", maxRetries: 1 },
      })
    );
    await harness.instance.executeLoadedPromptFile();

    assert.strictEqual(await markerLength(), 2);
    assert.deepStrictEqual(harness.integration.sentPrompts, ["step 1"]);
  });

  test("errored preCondition with onError continue runs the prompt and warns", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: { script: ERROR_SCRIPT },
        errorBehavior: { onError: "continue" },
      })
    );
    await harness.instance.executeLoadedPromptFile();

    assert.deepStrictEqual(harness.integration.sentPrompts, ["step 1"]);
    const eventsPath = (
      await findFiles(WorkflowPaths.runsRoot(workspace), "events.jsonl")
    )[0];
    const warning = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find(
        (event) =>
          event.eventType === TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED &&
          event.payload.statusMessage.message.includes(
            "Pre-condition could not run"
          )
      );
    assert.ok(warning);
    assert.strictEqual(warning.payload.statusMessage.severity, "warning");
  });

  test("gate errors and harness failures share one retry budget", async () => {
    harness = createExecutionHarness(workspace);
    harness.integration.harnessErrorFailure = true;
    harness.integration.onSend = async () => {
      (harness!.integration as any).lastFailureReason = "mock harness failure";
      return { success: false };
    };
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: {
          script: SHARED_BUDGET_GATE_SCRIPT,
          timeout: 500,
        },
        errorBehavior: { onError: "retry", maxRetries: 1 },
      })
    );
    await harness.instance.executeLoadedPromptFile();

    assert.strictEqual(await markerLength(), 2);
    assert.deepStrictEqual(harness.integration.sentPrompts, ["step 1"]);
    assert.strictEqual(
      harness.instance.promptQueue.getState().status,
      EXECUTION_STATES.ERROR
    );
  });

  test("ephemeral flow: new workflow -> set preCondition -> run gates the first prompt", async () => {
    harness = createExecutionHarness(workspace);
    const preCondition = {
      script: PASSING_SCRIPT,
      onPass: CONDITION_ACTIONS.SKIP_PROMPT,
    };
    // The dashboard flow for a brand-new workflow: the first property edit
    // eagerly creates the ephemeral working file, then persists the property
    // (mirrors WebviewSettingsSync.handleUpdateWorkflowProperties).
    await harness.instance.ensureEphemeralWorkingFile({
      initialProperties: { preCondition },
    });
    await harness.instance.updateWorkingFileProperties({ preCondition });
    // Then the user types a prompt in the editor and presses Run.
    await harness.instance.executeEphemeralPrompt(
      "step 1",
      undefined,
      ACTION_TYPES.RUN
    );

    assert.strictEqual(
      await markerExists(),
      true,
      "a preCondition set on a brand-new workflow must run before the first prompt"
    );
    assert.deepStrictEqual(
      harness.integration.sentPrompts,
      [],
      "onPass: skipPrompt must skip the prompt (it must never reach the harness)"
    );
  });

  test("new blank workflows materialize and execute default pre- and end-conditions", async () => {
    configService.setCliOverlay({
      defaults: {
        preCondition: {
          script: PASSING_SCRIPT,
          returns: "true",
        },
        endCondition: {
          script: PASSING_END_SCRIPT,
          returns: "true",
        },
      },
    });
    harness = createExecutionHarness(workspace);

    await harness.instance.executeEphemeralPrompt(
      "step 1",
      undefined,
      ACTION_TYPES.RUN
    );

    const workflow = harness.instance.promptQueue.getWorkflowFile();
    assert.deepStrictEqual(workflow.preCondition, {
      script: PASSING_SCRIPT,
      returns: "true",
    });
    assert.deepStrictEqual(workflow.endCondition, {
      script: PASSING_END_SCRIPT,
      returns: "true",
    });
    assert.strictEqual(workflow.agent, null);
    assert.strictEqual(await markerExists(), true);
    assert.strictEqual(
      await fs
        .access(path.join(workspace, END_MARKER_FILE))
        .then(() => true)
        .catch(() => false),
      true
    );
    assert.deepStrictEqual(harness.integration.sentPrompts, ["step 1"]);
    assert.strictEqual(
      harness.instance.promptQueue.getState().status,
      EXECUTION_STATES.COMPLETED
    );
  });

  test("direct shell command preCondition works (npm/.cmd shims, shell builtins)", async () => {
    // Regression: the file-not-found fallback used to spawn the bare command
    // name with shell:false — on Windows anything that is not a .exe (npm's
    // .cmd shim, builtins like echo) failed with spawn ENOENT, so the gate
    // "failed" without ever running. `echo` is a shell builtin on both cmd.exe
    // and sh, so it only passes when the command truly runs through the shell.
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: {
          script: "echo gate-ran",
          compareSource: "stdout",
          returns: "gate-ran",
          onPass: CONDITION_ACTIONS.SKIP_PROMPT,
          // Distinguish pass from spawn failure: a failed spawn would fall
          // through to the prompt, which the assertion below catches.
          onFail: CONDITION_ACTIONS.CONTINUE,
        },
      })
    );
    await harness.instance.executeLoadedPromptFile();

    assert.deepStrictEqual(
      harness.integration.sentPrompts,
      [],
      "the shell command must actually run and pass (spawn ENOENT would fall through to the prompt)"
    );
  });

  test("re-run after completion still gates the first prompt", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: {
          script: PASSING_SCRIPT,
          onPass: CONDITION_ACTIONS.SKIP_PROMPT,
        },
      })
    );
    await harness.instance.executeLoadedPromptFile();
    assert.strictEqual(await markerExists(), true, "first run must gate");

    // Reset the marker, then Run again on the completed workflow.
    await fs.rm(path.join(workspace, MARKER_FILE));
    await harness.instance.executeLoadedPromptFile();

    assert.strictEqual(
      await markerExists(),
      true,
      "the gate must run again on a restart-from-completed re-run"
    );
    assert.deepStrictEqual(harness.integration.sentPrompts, []);
  });

  test("a restored working file (fresh session) still gates the first prompt on run", async () => {
    // Session 1: load and execute (gate skips the prompt, run completes).
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        preCondition: {
          script: PASSING_SCRIPT,
          onPass: CONDITION_ACTIONS.SKIP_PROMPT,
        },
      })
    );
    await harness.instance.executeLoadedPromptFile();
    const runWorkingFilePath =
      harness.instance.promptQueue.getState().workingFilePath;
    assert.ok(runWorkingFilePath, "execution must leave a promoted run file");
    await harness.dispose();

    // Session 2: restore the run from its working file and Run again.
    harness = createExecutionHarness(workspace);
    await fs.rm(path.join(workspace, MARKER_FILE));
    await harness.instance.loadWorkingFile(runWorkingFilePath);
    await harness.instance.executeLoadedPromptFile();

    assert.strictEqual(
      await markerExists(),
      true,
      "a restored workflow must still run its workflow-level preCondition"
    );
    assert.deepStrictEqual(harness.integration.sentPrompts, []);
  });

  test("step-level preCondition: null disables the workflow-level gate for that step", async () => {
    harness = createExecutionHarness(workspace);
    await harness.instance.loadPromptFile(
      await writeWorkflow({
        steps: [{ prompt: "step 1", preCondition: null }],
        preCondition: {
          script: PASSING_SCRIPT,
          onPass: CONDITION_ACTIONS.SKIP_PROMPT,
        },
      })
    );
    await harness.instance.executeLoadedPromptFile();

    assert.strictEqual(
      await markerExists(),
      false,
      "step-level null must disable the inherited gate entirely"
    );
    assert.deepStrictEqual(harness.integration.sentPrompts, ["step 1"]);
  });
});
