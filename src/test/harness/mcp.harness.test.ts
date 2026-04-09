/**
 * MCP Dynamic Queue Extension Harness Tests
 *
 * Verifies that the FlightPath MCP server wires up correctly when a workflow
 * includes `mcpServers: ["flightpath"]`, and that the AI can call the
 * `flightpath_append_queue` tool to dynamically extend the queue.  The
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
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PromptFile } from "../../types/FlightPathTypes";
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
  // Two LLM calls: one to trigger the append, one for the appended step.
  this.timeout(HARNESS_TIMEOUT_MS * 2 + 10_000);

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
  // Test: AI extends the queue via the flightpath_append_queue MCP tool
  // -------------------------------------------------------------------------
  //
  // Workflow:
  //   Step 1 — AI calls flightpath_append_queue with a concrete prompt.
  //   Step 2 — (dynamically appended) AI runs a bash command that creates a
  //             marker file.
  //
  // Assertions:
  //   - CLI exits 0 (both steps completed).
  //   - Marker file exists (proves the MCP-appended step actually ran).
  // -------------------------------------------------------------------------

  test("copilot-cli: AI appends a step via MCP and appended step runs", function () {
    this.timeout(HARNESS_TIMEOUT_MS * 2 + 5_000);

    const mcpMarkerFile = path.join(tmpDir, "fp-mcp-result.txt");

    // Escape the path for safe embedding in the prompt string.
    const escapedPath = mcpMarkerFile.replace(/\\/g, "/");

    const workflow: PromptFile = {
      harness: "copilot-cli" as any,
      model: HARNESS_MODELS["copilot-cli"],
      mcpServers: ["flightpath"],
      steps: [
        {
          name: "trigger-mcp-append",
          prompt: [
            "You have access to an MCP tool called `flightpath_append_queue`.",
            "Call it now with a single step whose prompt is exactly:",
            `"Run the bash command: echo MCP_STEP_DONE > \\"${escapedPath}\\". Do not explain — just run it."`,
            "After calling the tool, say: 'Queue extended.'",
            "Do not run any bash commands yourself in this step.",
          ].join(" "),
        },
      ],
    };

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
        "This means either the AI did not call flightpath_append_queue,",
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
