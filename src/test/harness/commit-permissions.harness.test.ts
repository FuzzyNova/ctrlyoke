/**
 * Commit message generation permission harness tests.
 *
 * Commit generation runs headless with a narrow custom allow-list: read-only
 * tools plus `mcp__ctrlyoke-commit__submit_commit_message`. Each harness has
 * its own MCP tool naming and approval model, and a headless run has nobody to
 * answer an approval prompt, so a pattern that is not translated correctly
 * makes the submit call fail silently (OpenCode did, before its mapper
 * translated Claude-format MCP patterns).
 *
 * Every case uses the real `buildCommitWorkflowOverrides` permissions with a
 * probe MCP server registered under the commit server's id and tool name.
 *
 * Run only: npx mocha --ui tdd --exit --timeout 900000 out/test/harness/commit-permissions.harness.test.js
 * Exit code 3 from the CLI = harness not installed → the case is skipped.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { buildCommitWorkflowOverrides } from "../../git/CommitMessageGenerator";
import { MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME } from "../../utils/McpToolDefinitions";
import {
  CTRLYOKE_MCP_MODES,
  HARNESS_IDS,
  MCP_SERVER_IDS,
} from "../../types/DashboardConstants";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  MCP_STARTUP_RETRY_INSTRUCTION,
  buildMcpProbeServerScript,
  logAndMaybeSkip,
  runWorkflowFile,
} from "./helpers/harnessRunner";

suite("Commit message generation permissions", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  let tmpDir: string;
  let mcpServerScript: string;

  setup(function () {
    tmpDir = makeTempDir("ctrlyoke-commit-permissions-");
    mcpServerScript = path.join(tmpDir, "mcp-probe.js");
    fs.writeFileSync(mcpServerScript, buildMcpProbeServerScript());
  });

  teardown(function () {
    removeTempDir(tmpDir, (dir) =>
      console.log(`  ⚠  Could not clean up ${dir} (may still be in use)`)
    );
  });

  for (const harness of Object.values(HARNESS_IDS)) {
    test(`${harness}: headless commit allow-list lets the submit tool run`, function () {
      const markerPath = path.join(tmpDir, `${harness}-submit.calls`);
      const workflow: PromptFile = {
        ...buildCommitWorkflowOverrides(
          harness,
          HARNESS_MODELS[harness],
          {
            id: MCP_SERVER_IDS.CTRLYOKE_COMMIT,
            command: "node",
            args: [
              mcpServerScript.replace(/\\/g, "/"),
              MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
              markerPath.replace(/\\/g, "/"),
            ],
            autoApprove: true,
          },
          CTRLYOKE_MCP_MODES.NATIVE
        ),
        steps: [
          {
            name: `${harness}-commit-submit`,
            prompt: [
              `Call the ${MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME} tool from the ${MCP_SERVER_IDS.CTRLYOKE_COMMIT} MCP server exactly once.`,
              "Do not call any other tool or try another way to cause the same effect.",
              MCP_STARTUP_RETRY_INSTRUCTION,
            ].join(" "),
          },
        ],
      };

      const result = runWorkflowFile(workflow, tmpDir, `${harness}-commit`);
      if (logAndMaybeSkip(`${harness} (commit allow-list)`, result)) return;
      assert.strictEqual(
        result.exitCode,
        0,
        `${harness}: CLI exited with code ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
      assert.ok(
        fs.existsSync(markerPath),
        `${harness} did not call the allowed submit tool\nstdout: ${result.stdout}`
      );
    });
  }
});
