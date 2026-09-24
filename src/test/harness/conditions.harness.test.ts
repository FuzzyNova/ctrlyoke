/**
 * Script Condition Harness Tests
 *
 * Exercises the explicit script comparison (`compareSource` / `operator` /
 * `expected` / `ignoreCase`, see dev/implemented/SCRIPT_COMPARISON_REDESIGN_PLAN.md)
 * through the real CLI and a real harness, for both preConditions and
 * endConditions, and asserts on the `--json` verdicts rather than on side
 * effects alone.
 *
 * Run with:  npm run test:harness
 * Run only:  npm run test:harness -- --grep "Script Condition"
 *
 * Prerequisites:
 *   - npm run compile  (builds out/cli.js)
 *   - copilot-cli installed and authenticated
 *
 * Exit code 3 from the CLI means "harness not installed" — test is skipped.
 *
 * Cost shape: the operator matrix is built entirely from preConditions whose
 * prompt is skipped, so it costs no model calls — every wrong verdict hits
 * `stopWorkflow` instead of running the prompt. Only the cases that need a
 * real AI turn (endConditions, `$preCondition:` expansion, retry loops) pay
 * for one. copilot-cli only, for the same reasons as workflow.harness.test.ts:
 * condition evaluation is harness-agnostic once the turn completes.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type { CliJsonResult } from "../../cli/CliJsonResultBuilder";
import type {
  EndCondition,
  PreCondition,
  PromptFile,
  PromptStep,
} from "../../types/CtrlYokeTypes";
import {
  COMPARE_SOURCES,
  CONDITION_ACTIONS,
  HARNESS_IDS,
  SCRIPT_OPERATORS,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import {
  readComparisonSource,
  resolveScriptComparison,
  type ScriptComparisonConfig,
} from "../../utils/ScriptComparison";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  buildCounterScript,
  buildEmitScript,
  buildReadFileScript,
  emitCommand,
  logAndMaybeSkip,
  runWorkflowFileJson,
  type EmitSpec,
  type JsonRunResult,
} from "./helpers/harnessRunner";

const HARNESS = HARNESS_IDS.COPILOT_CLI;

/** Prompt for matrix steps whose preCondition must skip it. */
const NEVER_RUN_PROMPT =
  "Reply with exactly: this prompt should have been skipped by its preCondition.";

// ---------------------------------------------------------------------------
// Comparison matrix
// ---------------------------------------------------------------------------

interface ComparisonCase {
  name: string;
  comparison: ScriptComparisonConfig;
  emit: EmitSpec;
  shouldPass: boolean;
}

/**
 * Every operator, every compare source, `ignoreCase` on and off, the
 * zero-config default, and the regressions the redesign exists to fix.
 */
const COMPARISON_CASES: ComparisonCase[] = [
  // Zero-config default: exit code 0.
  {
    name: "default passes on exit 0",
    comparison: {},
    emit: { stdout: "anything", exitCode: 0 },
    shouldPass: true,
  },
  {
    name: "default fails on exit 1",
    comparison: {},
    emit: { exitCode: 1 },
    shouldPass: false,
  },
  {
    name: "default ignores stdout 'true' on a failing exit",
    comparison: {},
    emit: { stdout: "true", exitCode: 1 },
    shouldPass: false,
  },

  // exitCode source.
  {
    name: "exitCode eq numeric expected",
    comparison: { compareSource: COMPARE_SOURCES.EXIT_CODE, expected: 3 },
    emit: { exitCode: 3 },
    shouldPass: true,
  },
  {
    name: "exitCode ne 0 (the old returns: false)",
    comparison: {
      compareSource: COMPARE_SOURCES.EXIT_CODE,
      operator: SCRIPT_OPERATORS.NE,
      expected: 0,
    },
    emit: { exitCode: 2 },
    shouldPass: true,
  },
  {
    name: "exitCode ne 0 fails on a clean exit",
    comparison: {
      compareSource: COMPARE_SOURCES.EXIT_CODE,
      operator: SCRIPT_OPERATORS.NE,
      expected: 0,
    },
    emit: { exitCode: 0 },
    shouldPass: false,
  },
  {
    name: "exitCode gte",
    comparison: {
      compareSource: COMPARE_SOURCES.EXIT_CODE,
      operator: SCRIPT_OPERATORS.GTE,
      expected: 2,
    },
    emit: { exitCode: 3 },
    shouldPass: true,
  },
  {
    name: "exitCode 'true' is not a boolean alias for 0",
    comparison: { compareSource: COMPARE_SOURCES.EXIT_CODE, expected: "true" },
    emit: { exitCode: 0 },
    shouldPass: false,
  },

  // stdout: equality and case.
  {
    name: "stdout eq trims surrounding whitespace",
    comparison: { compareSource: COMPARE_SOURCES.STDOUT, expected: "READY" },
    emit: { stdout: "  READY\n" },
    shouldPass: true,
  },
  {
    name: "stdout eq is case-sensitive by default",
    comparison: { compareSource: COMPARE_SOURCES.STDOUT, expected: "ready" },
    emit: { stdout: "READY" },
    shouldPass: false,
  },
  {
    name: "stdout eq with ignoreCase",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      expected: "ready",
      ignoreCase: true,
    },
    emit: { stdout: "READY" },
    shouldPass: true,
  },
  {
    name: "stdout ne",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.NE,
      expected: "READY",
    },
    emit: { stdout: "BUSY" },
    shouldPass: true,
  },
  {
    name: "stdout text comparison has no hidden clean-exit requirement",
    comparison: { compareSource: COMPARE_SOURCES.STDOUT, expected: "DONE" },
    emit: { stdout: "DONE", exitCode: 1 },
    shouldPass: true,
  },

  // stdout: substring.
  {
    name: "stdout contains",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.CONTAINS,
      expected: "0 failing",
    },
    emit: { stdout: "12 passing, 0 failing" },
    shouldPass: true,
  },
  {
    name: "stdout contains with ignoreCase",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.CONTAINS,
      expected: "PASS",
      ignoreCase: true,
    },
    emit: { stdout: "all tests passed" },
    shouldPass: true,
  },
  {
    name: "stdout notContains fails when the text is present",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.NOT_CONTAINS,
      expected: "FAILED",
    },
    emit: { stdout: "3 PASSED, 2 FAILED" },
    shouldPass: false,
  },
  {
    name: "stdout notContains passes when the text is absent",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.NOT_CONTAINS,
      expected: "FAILED",
    },
    emit: { stdout: "3 PASSED" },
    shouldPass: true,
  },

  // Regressions from the old inferred waterfall.
  {
    name: "regression: eq PASS no longer substring-matches '3 PASSED, 2 FAILED'",
    comparison: { compareSource: COMPARE_SOURCES.STDOUT, expected: "PASS" },
    emit: { stdout: "3 PASSED, 2 FAILED" },
    shouldPass: false,
  },
  {
    name: "regression: eq 0 no longer numeric-matches '10 errors'",
    comparison: { compareSource: COMPARE_SOURCES.STDOUT, expected: 0 },
    emit: { stdout: "10 errors" },
    shouldPass: false,
  },

  // stdout: numeric.
  {
    name: "stdout gte",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.GTE,
      expected: 80,
    },
    emit: { stdout: "85" },
    shouldPass: true,
  },
  {
    name: "stdout gt fails on equal values",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.GT,
      expected: 85,
    },
    emit: { stdout: "85" },
    shouldPass: false,
  },
  {
    name: "stdout lte",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.LTE,
      expected: 85,
    },
    emit: { stdout: "85" },
    shouldPass: true,
  },
  {
    name: "stdout lt with a decimal",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.LT,
      expected: 90,
    },
    emit: { stdout: "85.5" },
    shouldPass: true,
  },
  {
    name: "numeric operator against non-numeric output fails",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.GTE,
      expected: 0,
    },
    emit: { stdout: "10 errors" },
    shouldPass: false,
  },

  // stdout: regex.
  {
    name: "stdout matches an anchored pattern",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.MATCHES,
      expected: "^\\d+ passing, 0 failing$",
    },
    emit: { stdout: "12 passing, 0 failing\n" },
    shouldPass: true,
  },
  {
    name: "stdout matches is unanchored",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.MATCHES,
      expected: "coverage: (9[0-9]|100)%",
    },
    emit: { stdout: "lines ok\ncoverage: 94%\ndone" },
    shouldPass: true,
  },
  {
    name: "stdout matches fails outside the range",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.MATCHES,
      expected: "coverage: (9[0-9]|100)%",
    },
    emit: { stdout: "coverage: 87%" },
    shouldPass: false,
  },

  // Emptiness, including stderr as the source.
  {
    name: "stdout isEmpty fails on output",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.IS_EMPTY,
    },
    emit: { stdout: "x" },
    shouldPass: false,
  },
  {
    name: "stderr isEmpty",
    comparison: {
      compareSource: COMPARE_SOURCES.STDERR,
      operator: SCRIPT_OPERATORS.IS_EMPTY,
    },
    emit: { stdout: "noise on stdout only" },
    shouldPass: true,
  },
  {
    name: "stderr isNotEmpty",
    comparison: {
      compareSource: COMPARE_SOURCES.STDERR,
      operator: SCRIPT_OPERATORS.IS_NOT_EMPTY,
    },
    emit: { stderr: "warning: something" },
    shouldPass: true,
  },
  {
    name: "stderr contains ignores the exit code",
    comparison: {
      compareSource: COMPARE_SOURCES.STDERR,
      operator: SCRIPT_OPERATORS.CONTAINS,
      expected: "deprecated",
    },
    emit: { stderr: "warning: deprecated api", exitCode: 1 },
    shouldPass: true,
  },

  // Half-configured: legal, and falls back to exit code 0.
  {
    name: "source + operator without expected falls back to exit 0",
    comparison: {
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.CONTAINS,
    },
    emit: { stdout: "unrelated", exitCode: 0 },
    shouldPass: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** A prompt that makes the AI write `content` to `filePath` with one tool call. */
function writeFilePrompt(filePath: string, content: string): string {
  return [
    "Run exactly this shell command once and do nothing else:",
    `node -e "require('fs').writeFileSync('${normalizedPath(filePath)}','${content}')"`,
  ].join(" ");
}

function describeRun(result: JsonRunResult): string {
  return `exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
}

function requireJson(result: JsonRunResult): CliJsonResult {
  assert.ok(
    result.json,
    `CLI printed no --json result\n${describeRun(result)}`
  );
  return result.json;
}

function stepAt(json: CliJsonResult, index: number) {
  const step = json.steps[index];
  assert.ok(step, `no step at index ${index} in the --json result`);
  return step;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("Script Condition Harness Tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  let tmpDir: string;
  let emitScript: string;
  let readFileScript: string;
  let counterScript: string;

  setup(function () {
    tmpDir = makeTempDir("cy-conditions-test-");
    emitScript = normalizedPath(path.join(tmpDir, "emit.js"));
    readFileScript = normalizedPath(path.join(tmpDir, "read-file.js"));
    counterScript = normalizedPath(path.join(tmpDir, "counter.js"));
    fs.writeFileSync(emitScript, buildEmitScript());
    fs.writeFileSync(readFileScript, buildReadFileScript());
    fs.writeFileSync(counterScript, buildCounterScript());
  });

  teardown(function () {
    removeTempDir(tmpDir, (dir) =>
      console.log(`  ⚠  Could not clean up ${dir} (may still be in use)`)
    );
  });

  // -------------------------------------------------------------------------
  // preCondition: operator matrix + advisory failure + $preCondition: refs
  // -------------------------------------------------------------------------
  //
  // One step per COMPARISON_CASES entry. The expected verdict routes to
  // `skipPrompt` and the wrong one to `stopWorkflow`, so the matrix costs no
  // model calls and any wrong verdict halts the run at that case.
  //
  // The last step is the only real AI turn: its preCondition fails with
  // `onFail: continue` (advisory), its prompt embeds `$preCondition:stdout`,
  // and its endCondition proves the expanded value reached the model by
  // matching what the AI wrote.
  // -------------------------------------------------------------------------

  test(`${HARNESS}: preCondition comparison matrix covers every operator and source`, function () {
    const refFile = path.join(tmpDir, "precondition-ref.txt");
    const magic = "CY-MAGIC-4817";

    const matrixSteps: PromptStep[] = COMPARISON_CASES.map((c) => {
      const preCondition: PreCondition = {
        script: emitCommand(emitScript, c.emit),
        ...c.comparison,
        onPass: c.shouldPass
          ? CONDITION_ACTIONS.SKIP_PROMPT
          : CONDITION_ACTIONS.STOP_WORKFLOW,
        onFail: c.shouldPass
          ? CONDITION_ACTIONS.STOP_WORKFLOW
          : CONDITION_ACTIONS.SKIP_PROMPT,
      };
      return { name: c.name, prompt: NEVER_RUN_PROMPT, preCondition };
    });

    const refStep: PromptStep = {
      name: "advisory preCondition feeds $preCondition:stdout",
      preCondition: {
        script: emitCommand(emitScript, { stdout: magic, exitCode: 1 }),
        compareSource: COMPARE_SOURCES.STDOUT,
        expected: "something-else",
        onFail: CONDITION_ACTIONS.CONTINUE,
      },
      prompt: writeFilePrompt(refFile, "$preCondition:stdout"),
      endCondition: {
        script: `node "${readFileScript}" "${normalizedPath(refFile)}"`,
        compareSource: COMPARE_SOURCES.STDOUT,
        operator: SCRIPT_OPERATORS.MATCHES,
        expected: "CY-MAGIC-\\d{4}",
      },
    };

    const workflow: PromptFile = {
      harness: HARNESS,
      model: HARNESS_MODELS[HARNESS],
      steps: [...matrixSteps, refStep],
    };

    const result = runWorkflowFileJson(workflow, tmpDir, "precondition-matrix");
    if (logAndMaybeSkip(`${HARNESS} (preCondition matrix)`, result)) return;
    const json = requireJson(result);

    // Check the matrix first: a wrong verdict names the case that caused it.
    COMPARISON_CASES.forEach((c, index) => {
      const step = stepAt(json, index);
      const label = `case ${index} "${c.name}"`;
      assert.ok(
        step.preCondition,
        `${label}: no preCondition verdict recorded`
      );
      const resolved = resolveScriptComparison(c.comparison);
      assert.strictEqual(
        step.preCondition.passed,
        c.shouldPass,
        `${label}: expected ${c.shouldPass ? "pass" : "fail"} (actual "${step.preCondition.actual}", stdout "${step.preCondition.stdout}", exit ${step.preCondition.exitCode})`
      );
      assert.strictEqual(step.preCondition.operator, resolved.operator, label);
      assert.strictEqual(
        step.preCondition.compareSource,
        resolved.compareSource,
        label
      );
      assert.strictEqual(
        step.preCondition.actual,
        // The emit script's real exit code is 0 when the spec leaves it out.
        readComparisonSource(resolved.compareSource, {
          ...c.emit,
          exitCode: c.emit.exitCode ?? 0,
        }),
        `${label}: reported actual`
      );
      assert.strictEqual(step.status, STEP_STATUS.SKIPPED, label);
    });

    assert.strictEqual(result.exitCode, 0, describeRun(result));

    const ref = stepAt(json, COMPARISON_CASES.length);
    assert.strictEqual(ref.preCondition?.passed, false);
    assert.strictEqual(ref.preCondition?.action, CONDITION_ACTIONS.CONTINUE);
    assert.strictEqual(ref.status, STEP_STATUS.COMPLETED);
    assert.ok(
      fs.existsSync(refFile),
      "advisory preCondition did not let the prompt run"
    );
    assert.strictEqual(
      fs.readFileSync(refFile, "utf8").trim(),
      magic,
      "$preCondition:stdout was not expanded into the prompt"
    );
    assert.strictEqual(ref.endCondition?.passed, true);
    assert.strictEqual(ref.endCondition?.operator, SCRIPT_OPERATORS.MATCHES);
  });

  // -------------------------------------------------------------------------
  // preCondition: stopWorkflow halts before the prompt (no model call)
  // -------------------------------------------------------------------------

  test(`${HARNESS}: failing preCondition with onFail stopWorkflow halts the run`, function () {
    const workflow: PromptFile = {
      harness: HARNESS,
      model: HARNESS_MODELS[HARNESS],
      steps: [
        {
          name: "gate",
          prompt: NEVER_RUN_PROMPT,
          preCondition: {
            script: emitCommand(emitScript, { stdout: "BLOCKED" }),
            compareSource: COMPARE_SOURCES.STDOUT,
            expected: "OPEN",
            onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
          },
        },
        { name: "must-not-run", prompt: NEVER_RUN_PROMPT },
      ],
    };

    const result = runWorkflowFileJson(workflow, tmpDir, "precondition-stop");
    if (logAndMaybeSkip(`${HARNESS} (preCondition stop)`, result)) return;
    const json = requireJson(result);

    assert.notStrictEqual(result.exitCode, 0, describeRun(result));
    const gate = stepAt(json, 0);
    assert.strictEqual(gate.preCondition?.passed, false);
    assert.strictEqual(gate.preCondition?.actual, "BLOCKED");
    assert.strictEqual(
      gate.preCondition?.action,
      CONDITION_ACTIONS.STOP_WORKFLOW
    );
    assert.strictEqual(gate.sessionId, null, "the gated prompt was sent");
    assert.strictEqual(stepAt(json, 1).status, STEP_STATUS.PENDING);
  });

  // -------------------------------------------------------------------------
  // endCondition: verdicts over real AI output, pass and onFail: continue
  // -------------------------------------------------------------------------

  test(`${HARNESS}: endCondition compares what the AI actually wrote`, function () {
    const reportFile = path.join(tmpDir, "ai-report.txt");
    const readReport = `node "${readFileScript}" "${normalizedPath(reportFile)}"`;

    const matchesCondition: EndCondition = {
      script: readReport,
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.MATCHES,
      expected: "\\d+ passing, 0 failing",
    };
    const failingCondition: EndCondition = {
      script: readReport,
      compareSource: COMPARE_SOURCES.STDOUT,
      operator: SCRIPT_OPERATORS.NOT_CONTAINS,
      expected: "PASSING",
      ignoreCase: true,
      onFail: CONDITION_ACTIONS.CONTINUE,
    };

    const workflow: PromptFile = {
      harness: HARNESS,
      model: HARNESS_MODELS[HARNESS],
      steps: [
        {
          name: "write-report",
          prompt: writeFilePrompt(
            reportFile,
            "cy-status: 7 passing, 0 failing"
          ),
          endCondition: matchesCondition,
        },
        {
          name: "advisory-end-condition",
          prompt: "Reply with exactly: ok",
          endCondition: failingCondition,
        },
      ],
    };

    const result = runWorkflowFileJson(workflow, tmpDir, "endcondition-output");
    if (logAndMaybeSkip(`${HARNESS} (endCondition output)`, result)) return;
    const json = requireJson(result);

    assert.strictEqual(result.exitCode, 0, describeRun(result));

    const written = stepAt(json, 0);
    assert.strictEqual(written.endCondition?.passed, true);
    assert.strictEqual(
      written.endCondition?.operator,
      SCRIPT_OPERATORS.MATCHES
    );
    assert.ok(
      written.endCondition?.actual.includes("7 passing, 0 failing"),
      `endCondition compared unexpected output: "${written.endCondition?.actual}"`
    );

    const advisory = stepAt(json, 1);
    assert.strictEqual(
      advisory.endCondition?.passed,
      false,
      "notContains with ignoreCase should fail on 'passing'"
    );
    assert.strictEqual(
      advisory.endCondition?.operator,
      SCRIPT_OPERATORS.NOT_CONTAINS
    );
    assert.strictEqual(
      advisory.status,
      STEP_STATUS.COMPLETED,
      "onFail: continue should advance past the failed endCondition"
    );
  });

  // -------------------------------------------------------------------------
  // endCondition: a failure stops the workflow by default
  // -------------------------------------------------------------------------

  test(`${HARNESS}: failing endCondition stops the workflow by default`, function () {
    const workflow: PromptFile = {
      harness: HARNESS,
      model: HARNESS_MODELS[HARNESS],
      steps: [
        {
          name: "checked",
          prompt: "Reply with exactly: ok",
          endCondition: {
            script: emitCommand(emitScript, { exitCode: 0 }),
            compareSource: COMPARE_SOURCES.EXIT_CODE,
            expected: 3,
          },
        },
        { name: "must-not-run", prompt: NEVER_RUN_PROMPT },
      ],
    };

    const result = runWorkflowFileJson(workflow, tmpDir, "endcondition-stop");
    if (logAndMaybeSkip(`${HARNESS} (endCondition stop)`, result)) return;
    const json = requireJson(result);

    assert.notStrictEqual(result.exitCode, 0, describeRun(result));
    const checked = stepAt(json, 0);
    assert.strictEqual(checked.endCondition?.passed, false);
    assert.strictEqual(checked.endCondition?.actual, "0");
    assert.strictEqual(checked.status, STEP_STATUS.FAILED);
    assert.strictEqual(stepAt(json, 1).status, STEP_STATUS.PENDING);
  });

  // -------------------------------------------------------------------------
  // endCondition: onPass retry re-runs the prompt until the budget is spent
  // -------------------------------------------------------------------------

  test(`${HARNESS}: endCondition onPass retry re-runs the prompt within maxRetries`, function () {
    const counterFile = normalizedPath(
      path.join(tmpDir, "pass-retry-counter.txt")
    );
    const workflow: PromptFile = {
      harness: HARNESS,
      model: HARNESS_MODELS[HARNESS],
      steps: [
        {
          name: "pass-retry",
          prompt: "Reply with exactly: ok",
          endCondition: {
            // Threshold 1: every call exits 0 and prints the running count.
            script: `node "${counterScript}" "${counterFile}" 1`,
            compareSource: COMPARE_SOURCES.STDOUT,
            operator: SCRIPT_OPERATORS.GTE,
            expected: 1,
            onPass: CONDITION_ACTIONS.RETRY,
            maxRetries: 1,
          },
        },
      ],
    };

    const result = runWorkflowFileJson(
      workflow,
      tmpDir,
      "endcondition-pass-retry"
    );
    if (logAndMaybeSkip(`${HARNESS} (onPass retry)`, result)) return;
    const json = requireJson(result);

    assert.strictEqual(result.exitCode, 0, describeRun(result));
    assert.strictEqual(
      fs.readFileSync(counterFile, "utf8").trim(),
      "2",
      "endCondition should run once per attempt (initial + 1 pass-retry)"
    );
    const step = stepAt(json, 0);
    assert.strictEqual(step.attempts, 2);
    assert.strictEqual(step.endCondition?.passed, true);
    assert.strictEqual(step.endCondition?.actual, "2");
  });
});
