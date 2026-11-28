/**
 * Reused Copilot terminal hook regression test.
 *
 * Copilot reads `.github/hooks/` when a hook fires, not once at process start.
 * A run that settles deletes its hook files while the PTY stays open for reuse,
 * so a turn sent into that terminal by a later run ran no `agentStop` hook and
 * its step never completed (dev/bugs/implemented/
 * copilot-reused-terminal-loses-hooks-across-runs.md). The fix rewrites the
 * hook files before the turn is typed (`restoreLiveProcessHookFiles`).
 *
 * This drives a real Copilot TUI in a pseudo-terminal: turn one runs with the
 * adapter's hooks, the hook files are then deleted exactly as settlement does,
 * and the restored files must fire for a second turn in the same process.
 *
 * Real-harness test, intentionally not part of `npm test`. Exit code 3 style
 * skipping applies: the case passes silently when Copilot is not installed.
 */

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as nodePty from "node-pty";
import * as path from "path";
import { CopilotHarnessAdapter } from "../../core/harness/copilot/CopilotHarnessAdapter";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import { removeTempDir } from "../helpers/tempWorkspace";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  initGitRepo,
  makeHarnessWorkspaceDir,
} from "./helpers/harnessRunner";

const TURN_TIMEOUT_MS = 180_000;
const POLL_MS = 500;
const FOCUS_IN = "\x1b[I";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function copilotInstalled(): boolean {
  const probe = spawnSync("copilot", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

function stopCount(marker: string): number {
  if (!fs.existsSync(marker)) return 0;
  return fs.readFileSync(marker, "utf-8").split("\n").filter(Boolean).length;
}

async function waitForStops(
  marker: string,
  expected: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (stopCount(marker) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  assert.fail(
    `${label}: expected ${expected} agentStop hook run(s), saw ${stopCount(marker)}`
  );
}

suite("Reused Copilot terminal hooks", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  test("hooks restored after settlement fire for a turn sent into the live TUI", async function () {
    if (!copilotInstalled()) return this.skip();
    const workspace = makeHarnessWorkspaceDir(
      HARNESS_IDS.COPILOT_CLI,
      "reused-terminal-hooks-"
    );
    let terminal: nodePty.IPty | undefined;
    try {
      initGitRepo(workspace);
      const marker = path.join(workspace, "stops.log");
      const hookScript = path.join(workspace, "record-stop.js");
      fs.writeFileSync(
        hookScript,
        `require("fs").appendFileSync(process.argv[2], "stop\\n");\n`
      );

      const adapter = new CopilotHarnessAdapter();
      const preparation = await adapter.planNotificationHookArgs(
        process.cwd(),
        workspace,
        0,
        undefined,
        [
          {
            event: "stop",
            command: `node "${hookScript}" "${marker}"`,
          },
        ],
        []
      );
      for (const mutation of preparation.mutations) await mutation.apply();

      terminal = nodePty.spawn(
        "copilot",
        [
          "--model",
          HARNESS_MODELS[HARNESS_IDS.COPILOT_CLI] ?? "",
          "--allow-all-tools",
          "-i",
          "Reply with exactly: one",
        ].filter(Boolean),
        {
          name: "xterm-256color",
          cols: 120,
          rows: 40,
          cwd: workspace,
          env: { ...process.env, TERM: "xterm-256color" } as Record<
            string,
            string
          >,
        }
      );
      let screen = "";
      terminal.onData((chunk) => {
        screen += chunk;
        const plain = screen
          .slice(-4000)
          .replace(/\x1b\[[0-9;?>]*[a-zA-Z]/g, "")
          .replace(/\s+/g, "");
        if (/Doyoutrustthefilesinthisfolder\?/.test(plain)) {
          screen = "";
          terminal?.write("\r");
        }
      });

      await waitForStops(marker, 1, "turn 1 (hooks written at spawn)");

      // What settlement does while the PTY is retained for reuse.
      for (const cleanupPath of adapter.getAdditionalCleanupFilePaths(
        workspace
      )) {
        fs.rmSync(cleanupPath, { force: true });
      }
      await adapter.cleanupWorkspaceArtifacts(workspace);
      assert.ok(
        !fs.existsSync(preparation.mutations[0].path ?? ""),
        "settlement removed the hook file"
      );

      await adapter.restoreLiveProcessHookFiles();

      terminal.write(FOCUS_IN);
      await new Promise((resolve) => setTimeout(resolve, 300));
      terminal.write(
        `${BRACKETED_PASTE_START}Reply with exactly: two${BRACKETED_PASTE_END}`
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      terminal.write("\r");

      await waitForStops(marker, 2, "turn 2 (hooks restored for reuse)");
    } finally {
      terminal?.kill();
      removeTempDir(workspace);
    }
  });
});
