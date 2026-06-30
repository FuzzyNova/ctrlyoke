/**
 * Shared helpers for harness integration tests.
 *
 * Provides the CLI runner, model constants, and logging utilities used by
 * all files under src/test/harness/.  The original hooks.harness.test.ts
 * keeps its own inline copy of these constants for backward compatibility;
 * new test files should import from here.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import type { PromptFile } from "../../../types/CtrlYokeTypes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the compiled CLI binary (resolved relative to the compiled output). */
const CLI_PATH = path.resolve(__dirname, "../../../cli.js");

/**
 * Per-harness wall-clock timeout in ms.
 *
 * These tests exercise real AI CLI processes end-to-end — they are correctness
 * checks, not performance checks.  Copilot-cli can take 90-120 s per LLM call
 * and multi-step / retry / MCP workflows involve two calls.  The generous limit
 * avoids flaky SIGTERM kills without any need for per-test multipliers.
 *
 * Total suite wall time is typically 10-15 minutes.
 */
export const HARNESS_TIMEOUT_MS = 900_000; // 15 minutes

/** Supported harness IDs (mirrors the Harness enum string values). */
export type HarnessId =
  | "copilot-cli"
  | "claude-cli"
  | "codex-cli"
  | "opencode-cli"
  | "qwen-cli"
  | "gemini-cli";

/**
 * Cheapest available model per harness.
 * - copilot-cli / opencode-cli have free-tier models → use them for most tests.
 * - claude-cli falls back to haiku (cheapest paid tier).
 */
export const HARNESS_MODELS: Record<HarnessId, string | undefined> = {
  "copilot-cli": "gpt-5-mini",
  "claude-cli": "haiku",
  "codex-cli": "gpt-5.4",
  "opencode-cli": "opencode/big-pickle",
  "qwen-cli": "qwen3.5-plus",
  "gemini-cli": "gemini-3-flash-preview",
};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RunResult {
  /** true when exit code 3 (harness binary not installed). */
  skipped: boolean;
  /** Raw exit code from the ctrlyoke CLI process. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Serialise `workflow` to disk then invoke the ctrlyoke CLI in headless mode.
 *
 * @param workflow   PromptFile object to execute.
 * @param tmpDir     Working directory for the run; workflow JSON is written here.
 * @param label      Short identifier used for the workflow filename (no spaces).
 * @param vars       Optional `--var key=value` pairs forwarded to the CLI.
 * @param timeoutMs  spawnSync wall-clock timeout in ms (default: HARNESS_TIMEOUT_MS).
 */
export function runWorkflowFile(
  workflow: PromptFile,
  tmpDir: string,
  label: string,
  vars?: Record<string, string>,
  timeoutMs: number = HARNESS_TIMEOUT_MS
): RunResult {
  const workflowFile = path.join(tmpDir, `${label}-test.flightpath.json`);
  fs.writeFileSync(workflowFile, JSON.stringify(workflow, null, 2));

  const varArgs: string[] = [];
  for (const [k, v] of Object.entries(vars ?? {})) {
    varArgs.push("--var", `${k}=${v}`);
  }

  const result = spawnSync(
    "node",
    [
      CLI_PATH,
      "run",
      workflowFile,
      "--headless",
      "--timeout",
      "180",
      ...varArgs,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      cwd: tmpDir,
    }
  );

  return {
    skipped: result.status === 3,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Logging / skip helpers
// ---------------------------------------------------------------------------

/**
 * Handle skip detection and return whether the test should be skipped.
 * Returns `true` when the harness was not installed (exit 3).
 *
 * stdout/stderr are intentionally NOT printed here — they are included in
 * assertion error messages so they only appear when a test actually fails.
 */
export function logAndMaybeSkip(label: string, result: RunResult): boolean {
  if (result.skipped) {
    console.log(`  ⚠  ${label} — SKIPPED (not installed)`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Script builders
// ---------------------------------------------------------------------------

/**
 * Source for a Node.js script that reads a file and prints "true" if its
 * content includes `keyword`, or "false" otherwise.
 *
 * Invocation: node file-check.js <filePath> <keyword>
 */
export function buildFileCheckScript(): string {
  return `"use strict";
const fs = require("fs");
const filePath = process.argv[2];
const keyword  = process.argv[3];
if (!filePath || !keyword) { process.stdout.write("false"); process.exit(0); }
try {
  const content = fs.readFileSync(filePath, "utf8").trim();
  process.stdout.write(content.includes(keyword) ? "true" : "false");
} catch {
  process.stdout.write("false");
}
`;
}

/**
 * Source for a Node.js script that increments a counter file and prints "true"
 * once the counter reaches the given threshold (default 2).
 *
 * Invocation: node counter.js <counterFile> [threshold]
 *
 * Use-case: force exactly one end-condition failure regardless of AI output,
 * to exercise the retry loop without depending on what the AI produces.
 */
export function buildCounterScript(): string {
  return `"use strict";
const fs = require("fs");
const counterFile = process.argv[2];
const threshold   = parseInt(process.argv[3] || "2", 10);
if (!counterFile) { process.stdout.write("false"); process.exit(0); }
let count = 0;
try { count = parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) || 0; } catch {}
count++;
fs.writeFileSync(counterFile, String(count));
process.stdout.write(count >= threshold ? "true" : "false");
`;
}
