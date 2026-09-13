/**
 * Harness Hook Integration Tests
 *
 * These tests invoke REAL AI CLI harnesses to verify that user-defined
 * hook events (stop, sessionStart, preToolUse, postToolUse, userPromptSubmit)
 * are actually delivered by each harness.
 *
 * Run with:  npm run test:harness
 * Run one:   npm run test:harness -- --grep "claude-cli"
 *
 * Prerequisites:
 *   - npm run compile  (builds out/cli.js)
 *   - Target harness must be installed and authenticated
 *
 * Exit code 3 from the CLI means "harness not installed" — test is skipped.
 * All other non-zero exit codes are treated as failures.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import type { PromptFile } from "../../types/CtrlYokeTypes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the compiled CLI binary */
const CLI_PATH = path.resolve(__dirname, "../../cli.js");
/** Repository root for harnesses that require repository-scoped hook discovery. */
const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * Timeout (ms) for a single harness run.
 * These are correctness checks, not performance checks — the limit is generous
 * to avoid flaky SIGTERM kills under API latency spikes.
 */
const HARNESS_TIMEOUT_MS = 900_000; // 15 minutes

/** Full set of supported harness IDs (for typed config maps below). */
type HarnessId =
  | "copilot-cli"
  | "claude-cli"
  | "codex-cli"
  | "opencode-cli"
  | "qwen-cli"
  | "antigravity-cli";

/** Active harnesses for this test run. Comment out any you don't want to run. */
const HARNESSES: HarnessId[] = [
  "copilot-cli",
  "claude-cli",
  "codex-cli",
  "opencode-cli",
  "qwen-cli",
  "antigravity-cli",
];

/**
 * Models to use per harness — prefer free/cheap tiers to minimise cost.
 */
const HARNESS_MODELS: Record<HarnessId, string | undefined> = {
  "copilot-cli": "gpt-5-mini",
  "claude-cli": "haiku",
  "codex-cli": "gpt-5.4",
  "opencode-cli": "opencode/big-pickle",
  "qwen-cli": "qwen3.5-plus",
  "antigravity-cli": "gemini-3.6-flash-low",
};

/**
 * Hooks that MUST fire for each harness (test fails if they don't).
 * "stop" fires for every harness on normal completion.
 */
const REQUIRED_HOOKS: Record<HarnessId, string[]> = {
  "copilot-cli": ["stop"],
  "claude-cli": ["stop"],
  "codex-cli": ["stop"],
  "opencode-cli": ["stop"],
  "qwen-cli": ["stop"],
  "antigravity-cli": ["stop"],
};

/**
 * Additional hooks that should fire for each harness if the AI uses a tool.
 * These are logged as warnings if missing, not hard failures — the AI
 * might theoretically answer without using bash in rare cases.
 */
const TOOL_HOOKS: Record<HarnessId, string[]> = {
  "copilot-cli": ["preToolUse", "postToolUse"],
  "claude-cli": ["preToolUse", "postToolUse"],
  "codex-cli": ["preToolUse", "postToolUse"],
  "opencode-cli": ["preToolUse", "postToolUse"],
  "qwen-cli": ["preToolUse", "postToolUse"],
  "antigravity-cli": ["preToolUse", "postToolUse"],
};

/**
 * Hooks supported at session level (expected unless AI skips session start).
 */
const SESSION_HOOKS: Record<HarnessId, string[]> = {
  "copilot-cli": ["sessionStart", "userPromptSubmit"],
  "claude-cli": ["sessionStart", "userPromptSubmit"],
  "codex-cli": ["sessionStart", "userPromptSubmit"],
  "opencode-cli": ["sessionStart", "userPromptSubmit"],
  "qwen-cli": ["sessionStart", "userPromptSubmit"],
  "antigravity-cli": ["sessionStart"],
};

// ---------------------------------------------------------------------------
// Hook recorder script (written to temp dir at test setup)
// ---------------------------------------------------------------------------

/**
 * Generates the source for a small Node.js script that appends one JSON line
 * per invocation to the given output file.
 *
 * Invocation: node record-hook.js <event> <outputFile>
 */
function buildRecorderScript(): string {
  return `"use strict";
const fs = require("fs");
const event = process.argv[2];
const outputFile = process.argv[3];
if (!event || !outputFile) process.exit(0);
const entry = JSON.stringify({ event, ts: Date.now() });
fs.appendFileSync(outputFile, entry + "\\n");
`;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface HookRecord {
  event: string;
  ts: number;
}

interface HarnessRunResult {
  /** true if the harness binary was not installed (exit code 3) */
  skipped: boolean;
  /** exit code from ctrlyoke CLI */
  exitCode: number | null;
  /** stdout output from ctrlyoke CLI */
  stdout: string;
  /** stderr output from ctrlyoke CLI */
  stderr: string;
  /** hook records written by the recorder script */
  records: HookRecord[];
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a PromptFile workflow object for the given harness.
 * All 5 hook types are registered; unsupported ones are silently ignored
 * by the harness. The prompt forces bash tool use so preToolUse/postToolUse
 * hooks have a chance to fire on harnesses that support them.
 */
function buildWorkflow(harness: HarnessId, recorderScript: string): PromptFile {
  // Use {{outputFile}} via --var so the path doesn't need escaping in the
  // hook command string (the CLI handles the substitution before passing to
  // the harness config system).
  const hookScriptPath = recorderScript.replace(/\\/g, "/");
  const hookCmd = (event: string) =>
    `node ${hookScriptPath} ${event} {{outputFile}}`;

  return {
    harness: harness as any,
    // Force full tool permissions so the AI can actually run bash — avoids
    // harnesses that require interactive approval blocking in headless mode.
    toolPermissions: { mode: "dangerouslyAllowAll" },
    ...(HARNESS_MODELS[harness] !== undefined && {
      model: HARNESS_MODELS[harness],
    }),
    hooks: [
      { event: "stop", command: hookCmd("stop") },
      { event: "sessionStart", command: hookCmd("sessionStart") },
      { event: "preToolUse", command: hookCmd("preToolUse") },
      { event: "postToolUse", command: hookCmd("postToolUse") },
      { event: "userPromptSubmit", command: hookCmd("userPromptSubmit") },
    ],
    steps: [
      {
        name: `hook-test-${harness}`,
        // Explicit bash invocation maximises chance of preToolUse/postToolUse
        // firing on harnesses that support those events.
        prompt:
          "Run the bash command `ls` to list files in the current working directory. Do not explain — just run it.",
      },
    ],
  };
}

/**
 * Invoke the ctrlyoke CLI for a single harness and return structured results.
 */
function runHarness(
  harness: HarnessId,
  tmpDir: string,
  recorderScript: string
): HarnessRunResult {
  const outputFile = path.join(tmpDir, `${harness}-hooks.jsonl`);
  const outputFileArg = outputFile.replace(/\\/g, "/");
  const workflowFile = path.join(tmpDir, `${harness}-test.ctrlyoke.json`);
  const harnessCwd = harness === "copilot-cli" ? REPO_ROOT : tmpDir;

  const workflow = buildWorkflow(harness, recorderScript);
  fs.writeFileSync(workflowFile, JSON.stringify(workflow, null, 2));

  const result = spawnSync(
    "node",
    [
      CLI_PATH,
      "run",
      workflowFile,
      "--headless",
      "--timeout",
      "60",
      "--var",
      `outputFile=${outputFileArg}`,
    ],
    {
      encoding: "utf8",
      timeout: HARNESS_TIMEOUT_MS,
      cwd: harnessCwd,
    }
  );

  // Exit code 3 = harness not installed
  if (result.status === 3) {
    return {
      skipped: true,
      exitCode: 3,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      records: [],
    };
  }

  // Parse hook records
  const records: HookRecord[] = [];
  if (fs.existsSync(outputFile)) {
    const lines = fs
      .readFileSync(outputFile, "utf8")
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as HookRecord);
      } catch {
        // ignore malformed lines
      }
    }
  }

  // Diagnostic: dump settings file and ctrlyoke log on failure
  if (records.length === 0) {
    const qwenSettings = path.join(tmpDir, ".qwen", "settings.json");
    if (fs.existsSync(qwenSettings)) {
      console.log(
        `  [diag] .qwen/settings.json content:\n${fs.readFileSync(qwenSettings, "utf8")}`
      );
    } else {
      console.log(`  [diag] .qwen/settings.json NOT FOUND at: ${qwenSettings}`);
    }
    // Print ctrlyoke log if available
    const fpLogsDir = path.join(tmpDir, ".ctrlyoke", "logs");
    if (fs.existsSync(fpLogsDir)) {
      const logFiles = fs
        .readdirSync(fpLogsDir)
        .filter((f) => f.endsWith(".log"));
      for (const lf of logFiles.slice(0, 1)) {
        const logContent = fs.readFileSync(path.join(fpLogsDir, lf), "utf8");
        const lines = logContent
          .split("\n")
          .filter((l) => /hook|qwen|setting/i.test(l));
        if (lines.length > 0) {
          console.log(
            `  [diag] ctrlyoke log (hook-related):\n${lines.slice(0, 30).join("\n")}`
          );
        }
      }
    }
  }

  return {
    skipped: false,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    records,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("Harness Hook Tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  let tmpDir: string;
  let recorderScript: string;

  setup(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cy-hook-test-"));
    recorderScript = path.join(tmpDir, "record-hook.js");
    fs.writeFileSync(recorderScript, buildRecorderScript());
  });

  teardown(function () {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // EBUSY on Windows if a harness process still has files open; best-effort cleanup
      console.log(`  ⚠  Could not clean up ${tmpDir} (may still be in use)`);
    }
  });

  for (const harness of HARNESSES) {
    // Capture loop variable for each test closure
    const h = harness;

    test(`${h}: required hooks fire on successful run`, function () {
      this.timeout(HARNESS_TIMEOUT_MS);

      const { skipped, exitCode, stdout, stderr, records } = runHarness(
        h,
        tmpDir,
        recorderScript
      );

      if (skipped) {
        console.log(`  ⚠  ${h} — SKIPPED (not installed)`);
        return; // Mocha doesn't have a built-in skip in TDD mode; just return
      }

      const firedEvents = new Set(records.map((r) => r.event));

      // Log everything that fired for visibility
      if (records.length > 0) {
        console.log(
          `  ↳ hooks fired: ${[...firedEvents].join(", ")} (${records.length} total)`
        );
      } else {
        console.log(`  ↳ no hooks fired`);
      }

      // Log session/tool hooks that were expected but missed (non-fatal warnings)
      const sessionMissed = SESSION_HOOKS[h].filter((e) => !firedEvents.has(e));
      if (sessionMissed.length > 0) {
        console.log(
          `  ↳ session hooks not fired (may be normal): ${sessionMissed.join(", ")}`
        );
      }

      const toolMissed = TOOL_HOOKS[h].filter((e) => !firedEvents.has(e));
      if (toolMissed.length > 0) {
        console.log(
          `  ↳ tool hooks not fired (AI may not have used bash): ${toolMissed.join(", ")}`
        );
      }

      // Hard assertion: workflow must have completed successfully
      assert.strictEqual(
        exitCode,
        0,
        `${h}: CLI exited with code ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`
      );

      // Hard assertion: required hooks must have fired
      for (const event of REQUIRED_HOOKS[h]) {
        assert.ok(
          firedEvents.has(event),
          `${h}: required hook "${event}" did not fire (fired: ${[...firedEvents].join(", ")})`
        );
      }
    });
  }
});
