/**
 * End-to-end commit message generation harness tests.
 *
 * Runs the real `ctrlyoke commit --print-only` against a staged change, with
 * ctrlyoke's real MCP server, once per harness and `ctrlyokeMcpMode`:
 *
 * - `native`: the message must arrive through the `submit_commit_message`
 *   MCP tool in a single run. A second run means the MCP run submitted
 *   nothing and the skill fallback rescued it, which would hide a broken
 *   MCP path.
 * - `skill`: the message must arrive through the commit-message skill's CLI
 *   command, the only path skill mode has.
 *
 * Generation never falls back to the model's response text, so a printed
 * message proves one of those submissions worked.
 *
 * Run only: npx mocha --ui tdd --exit --timeout 900000 out/test/harness/commit-generation.harness.test.js
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { detectHarness } from "../../core/harness/shared/HarnessDetection";
import {
  CTRLYOKE_MCP_MODES,
  HARNESS_IDS,
} from "../../types/DashboardConstants";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  findRunFiles,
  initGitRepo,
  isolateRunState,
  runCliCommand,
  runsRootFor,
} from "./helpers/harnessRunner";

/** Either mode must submit in its first run; a second run is a fallback. */
const EXPECTED_RUN_COUNT = 1;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  }
}

suite("Commit message generation end to end", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  let tmpDir: string;
  let restoreRunState: () => void;

  setup(function () {
    tmpDir = makeTempDir("ctrlyoke-commit-generation-");
    restoreRunState = isolateRunState(tmpDir);
  });

  teardown(function () {
    restoreRunState();
    // A failed case keeps its repo and run history so its events can be read.
    if (this.currentTest?.state === "failed") {
      console.log(`  ⚠  Kept ${tmpDir} for inspection`);
      return;
    }
    removeTempDir(tmpDir, (dir) =>
      console.log(`  ⚠  Could not clean up ${dir} (may still be in use)`)
    );
  });

  for (const harness of Object.values(HARNESS_IDS)) {
    for (const mode of Object.values(CTRLYOKE_MCP_MODES)) {
      test(`${harness}: ${mode} mode submits a generated commit message`, async function () {
        const detection = await detectHarness(
          IntegrationFactory.createCapabilityProvider(harness)
        );
        if (!detection.available) {
          console.log(
            `  ⚠  ${harness} (${mode} commit) — SKIPPED (not installed)`
          );
          this.skip();
        }

        const workspace = path.join(tmpDir, "repo");
        fs.mkdirSync(path.join(workspace, ".ctrlyoke"), { recursive: true });
        initGitRepo(workspace);
        git(workspace, ["config", "user.email", "test@example.com"]);
        git(workspace, ["config", "user.name", "CtrlYoke Test"]);
        fs.writeFileSync(
          path.join(workspace, ".ctrlyoke", "settings.json"),
          JSON.stringify({
            commit: { harness, model: HARNESS_MODELS[harness] },
            execution: { ctrlyokeMcpMode: mode },
          })
        );
        fs.writeFileSync(
          path.join(workspace, "greeting.js"),
          "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n"
        );
        git(workspace, ["add", "greeting.js"]);

        const result = runCliCommand(["commit", "--print-only"], workspace);
        const details = `stdout: ${result.stdout}\nstderr: ${result.stderr}`;
        assert.strictEqual(
          result.exitCode,
          0,
          `${harness} (${mode}): commit exited with ${result.exitCode}\n${details}`
        );
        assert.ok(
          result.stdout.trim().length > 0,
          `${harness} (${mode}): no commit message printed\n${details}`
        );

        const runCount = findRunFiles(
          runsRootFor(workspace),
          "events.jsonl"
        ).length;
        assert.strictEqual(
          runCount,
          EXPECTED_RUN_COUNT,
          `${harness} (${mode}): expected ${EXPECTED_RUN_COUNT} run(s), found ${runCount}; a second run means the first submitted nothing\n${details}`
        );
      });
    }
  }
});
