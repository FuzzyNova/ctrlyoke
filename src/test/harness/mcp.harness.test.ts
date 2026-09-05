/**
 * MCP Dynamic Queue Extension Harness Tests
 *
 * Verifies that the ctrlyoke MCP server wires up correctly when a workflow
 * includes `mcpServers: ["ctrlyoke"]`, and that the AI can call the
 * `append_step` tool to dynamically extend the queue.  The
 * appended step must actually execute and produce a verifiable side effect.
 *
 * Run with:  npm run test:harness
 * Run only:  npm run test:harness -- --grep "mcp"
 *
 * Prerequisites:
 *   - npm run compile  (builds out/cli.js)
 *   - copilot-cli installed and authenticated
 *
 * Exit code 3 from the CLI = harness not installed → test is skipped.
 *
 * opencode-cli was tried as the default here but is not currently usable:
 * the `opencode` binary appears to keep a global session/project database
 * (~/.local/share/opencode/opencode.db) and reattaches to a recently-active
 * project instead of strictly scoping to the spawn's cwd, so it operates
 * against the real repo instead of each test's isolated tmp dir. Revisit
 * once that's resolved.
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
} from "./helpers/harnessRunner";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("MCP Dynamic Queue Extension Harness Tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  let tmpDir: string;

  setup(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-mcp-test-"));
  });

  teardown(function () {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      console.log(`  ⚠  Could not clean up ${tmpDir} (may still be in use)`);
    }
  });

  // -------------------------------------------------------------------------
  // Test: finalStep appends via MCP, appended step runs, finalStep re-fires
  // -------------------------------------------------------------------------
  //
  // Workflow:
  //   Step 1   — AI writes an initial marker file (proves regular step ran).
  //   finalStep pass 1 — AI calls workflow_status, finds no
  //              "fp-appended-step" in completed steps, calls
  //              append_step to add one.
  //   Step 2   — (dynamically appended) AI writes the appended marker file.
  //   finalStep pass 2 — AI calls workflow_status, finds
  //              "fp-appended-step" in completed steps, writes the
  //              final-pass-2 marker file.
  //
  // Assertions:
  //   - CLI exits 0.
  //   - Initial marker exists (regular step ran).
  //   - Appended marker exists (MCP-appended step ran).
  //   - Final-pass-2 marker exists (finalStep fired again after appended step).
  // -------------------------------------------------------------------------

  test("copilot-cli: finalStep appends via MCP, appended step runs, finalStep executes again", function () {
    this.timeout(HARNESS_TIMEOUT_MS);

    const initialFile = path.join(tmpDir, "fp-initial.txt");
    const appendedFile = path.join(tmpDir, "fp-appended.txt");
    const finalPass2File = path.join(tmpDir, "fp-final-pass2.txt");

    const appendedPath = appendedFile.replace(/\\/g, "/");
    const finalPass2Path = finalPass2File.replace(/\\/g, "/");
    const initialPath = initialFile.replace(/\\/g, "/");

    const workflow: PromptFile = {
      harness: "copilot-cli" as any,
      model: HARNESS_MODELS["copilot-cli"],
      steps: [
        {
          name: "initial",
          prompt: `Run the bash command exactly as written: \`echo FP_INITIAL > "${initialPath}"\`. Do not explain — just run it.`,
        },
      ],
      finalStep: {
        name: "fp-final-step",
        mcpServers: ["ctrlyoke"],
        prompt: [
          "Call the tool 'workflow_status' (no parameters).",
          "Examine the JSON response. Look for a completed step named 'fp-appended-step'.",
          "",
          `IF 'fp-appended-step' IS in the completed steps: run exactly \`echo FP_FINAL_PASS2 > "${finalPass2Path}"\` and say: "Second finalStep pass."`,
          "",
          `IF 'fp-appended-step' is NOT in the completed steps: call 'append_step' with one step — name "fp-appended-step", prompt "Run exactly: echo FP_APPENDED > \\"${appendedPath}\\". Do not explain — just run it." Then say: "First finalStep pass: appended fp-appended-step."`,
          "",
          "Do nothing else.",
        ].join("\n"),
      } as any,
    };

    const result = runWorkflowFile(workflow, tmpDir, "fp-final-step");

    if (logAndMaybeSkip("copilot-cli (finalStep+mcp)", result)) return;

    assert.strictEqual(
      result.exitCode,
      0,
      `copilot-cli: CLI exited with code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    assert.ok(
      fs.existsSync(initialFile),
      `copilot-cli: initial step marker not created — initial step may not have run\nstdout: ${result.stdout}`
    );

    assert.ok(
      fs.existsSync(appendedFile),
      [
        "copilot-cli: appended step marker not created.",
        "This means the finalStep did not call append_step,",
        "or the appended step did not execute.",
        `Expected file: ${appendedFile}`,
        `stdout: ${result.stdout}`,
      ].join("\n")
    );

    assert.ok(
      fs.existsSync(finalPass2File),
      [
        "copilot-cli: finalStep second-pass marker not created.",
        "This means finalStep did not execute a second time after the appended step ran.",
        `Expected file: ${finalPass2File}`,
        `stdout: ${result.stdout}`,
      ].join("\n")
    );
  });

  // -------------------------------------------------------------------------
  // Test: AI extends the queue via the append_step MCP tool
  // -------------------------------------------------------------------------
  //
  // Workflow:
  //   Step 1 — AI calls append_step with a concrete prompt.
  //   Step 2 — (dynamically appended) AI runs a bash command that creates a
  //             marker file.
  //
  // Assertions:
  //   - CLI exits 0 (both steps completed).
  //   - Marker file exists (proves the MCP-appended step actually ran).
  // -------------------------------------------------------------------------

  test("copilot-cli: AI appends a step via MCP and appended step runs", function () {
    this.timeout(HARNESS_TIMEOUT_MS);

    const mcpMarkerFile = path.join(tmpDir, "fp-mcp-result.txt");

    // Escape the path for safe embedding in the prompt string.
    const escapedPath = mcpMarkerFile.replace(/\\/g, "/");

    const workflow: PromptFile = {
      harness: "copilot-cli" as any,
      model: HARNESS_MODELS["copilot-cli"],
      mcpServers: ["ctrlyoke"],
      steps: [
        {
          name: "trigger-mcp-append",
          prompt: [
            "You have access to an MCP tool called `append_step`.",
            "Call it now with a single step whose prompt is exactly:",
            `"Run the bash command: echo MCP_STEP_DONE > \\"${escapedPath}\\". Do not explain — just run it."`,
            "After calling the tool, say: 'Queue extended.'",
            "Do not run any bash commands yourself in this step.",
          ].join(" "),
        },
      ],
    };

    // Two LLM calls (step 1 appends, step 2 runs) — pass double timeout.
    const result = runWorkflowFile(workflow, tmpDir, "claude-mcp");

    if (logAndMaybeSkip("copilot-cli (mcp)", result)) return;

    assert.strictEqual(
      result.exitCode,
      0,
      `copilot-cli: CLI exited with code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    assert.ok(
      fs.existsSync(mcpMarkerFile),
      [
        "copilot-cli: MCP marker file was not created.",
        "This means either the AI did not call append_step,",
        "or the appended step did not execute.",
        `Expected file: ${mcpMarkerFile}`,
        `stdout: ${result.stdout}`,
      ].join("\n")
    );

    const content = fs.readFileSync(mcpMarkerFile, "utf8").trim();
    assert.ok(
      content.includes("MCP_STEP_DONE"),
      `copilot-cli: marker file content unexpected: "${content}"`
    );
  });
});
