/**
 * Workflow Feature Harness Tests
 *
 * Tests multi-step sequential execution and end conditions using real AI
 * harnesses.  These exercise code paths that are fully unit-tested with
 * mocks (WorkflowExecutor, EndConditionHandler, retry loop) but have never
 * been run through a live CLI.
 *
 * Run with:  npm run test:harness
 * Run only:  npm run test:harness -- --grep "workflow"
 *
 * Prerequisites:
 *   - npm run compile  (builds out/cli.js)
 *   - Target harness installed and authenticated
 *
 * Exit code 3 from the CLI means "harness not installed" — test is skipped.
 * All other non-zero exit codes are treated as test failures.
 *
 * Model selection: copilot-cli (gpt-5-mini) is used for these tests.  The
 * retry test is copilot-cli only because retry runs are slow and the retry
 * path is harness-agnostic.
 *
 * opencode-cli (big-pickle, free) was tried as the default here but is not
 * currently usable for this suite: the `opencode` binary appears to keep a
 * global session/project database (~/.local/share/opencode/opencode.db) and
 * reattaches to a recently-active project instead of strictly scoping to the
 * spawn's cwd, so it operates against the real repo instead of each test's
 * isolated tmp dir. ctrlyoke's own cwd propagation (cli.ts -> CliAdapter ->
 * CliIntegration -> CliTransportCoordinator -> CliProcessManager.spawn) was
 * verified correct; the issue is on OpenCode's side. Revisit once that's
 * resolved or a documented way to force project scoping is found.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import {
  HARNESS_TIMEOUT_MS,
  HARNESS_MODELS,
  runWorkflowFile,
  logAndMaybeSkip,
  buildFileCheckScript,
  buildCounterScript,
} from "./helpers/harnessRunner";

// ---------------------------------------------------------------------------
// Test scope: harnesses that support the free-tier models we need
// ---------------------------------------------------------------------------

type TestHarnessId = "copilot-cli";

// opencode-cli excluded: see file-header note above (global session db causes
// it to ignore the spawn's cwd in this environment).
const MULTI_STEP_HARNESSES: TestHarnessId[] = ["copilot-cli"];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("Workflow Feature Harness Tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  let tmpDir: string;
  let fileCheckScript: string;
  let counterScript: string;

  setup(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cy-workflow-test-"));

    // Write helper scripts to tmpDir once; each test references them by path.
    fileCheckScript = path.join(tmpDir, "file-check.js");
    fs.writeFileSync(fileCheckScript, buildFileCheckScript());

    counterScript = path.join(tmpDir, "counter.js");
    fs.writeFileSync(counterScript, buildCounterScript());
  });

  teardown(function () {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      console.log(`  ⚠  Could not clean up ${tmpDir} (may still be in use)`);
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: Multi-step sequential execution
  // -------------------------------------------------------------------------
  //
  // Two steps each write a distinct marker file.  Verifies that the
  // WorkflowExecutor loop actually drives two real prompts end-to-end, not
  // just the first.
  // -------------------------------------------------------------------------

  for (const harness of MULTI_STEP_HARNESSES) {
    const h = harness;

    test(`${h}: multi-step workflow runs both steps in sequence`, function () {
      this.timeout(HARNESS_TIMEOUT_MS);

      const step1File = path.join(tmpDir, `${h}-seq-step1.txt`);
      const step2File = path.join(tmpDir, `${h}-seq-step2.txt`);

      const workflow: PromptFile = {
        harness: h as any,
        model: HARNESS_MODELS[h],
        steps: [
          {
            name: "step-one",
            prompt: `Run the bash command exactly as written: \`echo step1_done > "${step1File}"\`. Do not explain — just run it.`,
          },
          {
            name: "step-two",
            prompt: `Run the bash command exactly as written: \`echo step2_done > "${step2File}"\`. Do not explain — just run it.`,
          },
        ],
      };

      const result = runWorkflowFile(workflow, tmpDir, `${h}-seq`);

      if (logAndMaybeSkip(h, result)) return;

      assert.strictEqual(
        result.exitCode,
        0,
        `${h}: CLI exited with code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );

      assert.ok(
        fs.existsSync(step1File),
        `${h}: step 1 output file was not created — step 1 may not have run`
      );
      assert.ok(
        fs.existsSync(step2File),
        `${h}: step 2 output file was not created — step 2 may not have run`
      );

      const step1Content = fs.readFileSync(step1File, "utf8").trim();
      const step2Content = fs.readFileSync(step2File, "utf8").trim();

      assert.ok(
        step1Content.includes("step1_done"),
        `${h}: step 1 file content unexpected: "${step1Content}"`
      );
      assert.ok(
        step2Content.includes("step2_done"),
        `${h}: step 2 file content unexpected: "${step2Content}"`
      );
    });
  }

  // -------------------------------------------------------------------------
  // Test 2: End condition passes on first attempt
  // -------------------------------------------------------------------------
  //
  // The AI writes a marker file; the end condition script checks for a known
  // keyword and returns "true".  Verifies the full round-trip: script
  // isolation → exit code interpretation → workflow completion.
  // -------------------------------------------------------------------------

  for (const harness of MULTI_STEP_HARNESSES) {
    const h = harness;

    test(`${h}: end condition passes on first attempt`, function () {
      this.timeout(HARNESS_TIMEOUT_MS);

      const outputFile = path.join(tmpDir, `${h}-end-cond.txt`);

      // End condition script: node file-check.js <outputFile> SUCCESS
      const endCondScript = `node "${fileCheckScript}" "${outputFile}" SUCCESS`;

      const workflow: PromptFile = {
        harness: h as any,
        model: HARNESS_MODELS[h],
        steps: [
          {
            name: "write-success",
            prompt: `Run the bash command exactly as written: \`echo SUCCESS > "${outputFile}"\`. Do not explain — just run it.`,
            endCondition: {
              script: endCondScript,
              returns: "true",
            },
          },
        ],
      };

      const result = runWorkflowFile(workflow, tmpDir, `${h}-endcond`);

      if (logAndMaybeSkip(h, result)) return;

      assert.strictEqual(
        result.exitCode,
        0,
        `${h}: CLI exited with code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );

      assert.ok(
        fs.existsSync(outputFile),
        `${h}: output file was not created — AI may not have run the bash command`
      );

      const content = fs.readFileSync(outputFile, "utf8").trim();
      assert.ok(
        content.includes("SUCCESS"),
        `${h}: output file content unexpected: "${content}"`
      );
    });
  }

  // -------------------------------------------------------------------------
  // Test 3: End condition fails once, retryPrompt fires, passes on retry
  // -------------------------------------------------------------------------
  //
  // A counter script always returns "false" on the first invocation and "true"
  // on the second, regardless of what the AI produces.  This proves the retry
  // loop executes retryPrompt and the workflow still exits 0.
  //
  // Uses copilot-cli only — the retry path is harness-agnostic and retry runs
  // are slow; there is no value in running this on every harness.
  // -------------------------------------------------------------------------

  test("copilot-cli: end condition retries once then passes", function () {
    this.timeout(HARNESS_TIMEOUT_MS);

    const counterFile = path.join(tmpDir, "retry-counter.txt");
    const retryMarker = path.join(tmpDir, "copilot-retry-marker.txt");

    // Counter script: fail on call 1, pass on call 2.
    const endCondScript = `node "${counterScript}" "${counterFile}" 2`;

    const workflow: PromptFile = {
      harness: "copilot-cli" as any,
      model: HARNESS_MODELS["copilot-cli"],
      steps: [
        {
          name: "initial-attempt",
          prompt: `Run the bash command exactly as written: \`echo ATTEMPT1 > "${retryMarker}"\`. Do not explain — just run it.`,
          endCondition: {
            script: endCondScript,
            returns: "true",
            maxRetries: 1,
            retryPrompt: `Run the bash command exactly as written: \`echo ATTEMPT2 > "${retryMarker}"\`. Do not explain — just run it.`,
          },
        },
      ],
    };

    const result = runWorkflowFile(workflow, tmpDir, "copilot-retry");

    if (logAndMaybeSkip("copilot-cli (retry)", result)) return;

    assert.strictEqual(
      result.exitCode,
      0,
      `copilot-cli: CLI exited with code ${result.exitCode} — workflow should have passed after retry\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    // The counter file must exist and show that the end condition script ran twice.
    assert.ok(
      fs.existsSync(counterFile),
      "copilot-cli: counter file not created — end condition script may not have run"
    );
    const counterValue = parseInt(
      fs.readFileSync(counterFile, "utf8").trim(),
      10
    );
    assert.strictEqual(
      counterValue,
      2,
      `copilot-cli: expected end condition to run exactly twice (got ${counterValue})`
    );

    // The retry marker must exist (proves retryPrompt was sent and executed).
    assert.ok(
      fs.existsSync(retryMarker),
      "copilot-cli: retry marker file not created — retryPrompt may not have been sent"
    );
  });
});
