/**
 * Shared helpers for harness integration tests.
 *
 * Provides the CLI runner, model constants, and logging utilities used by
 * all files under src/test/harness/.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import type { PromptFile } from "../../../types/CtrlYokeTypes";
import type { CliJsonResult } from "../../../cli/CliJsonResultBuilder";
import type { HarnessId } from "../../../types/DashboardConstants";

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

export type { HarnessId };

/**
 * Model per harness — the cheapest tier of the current generation, so a run
 * exercises what users actually pick without paying for a flagship model.
 * - copilot-cli remains the default for tool-execution-dependent tests (see
 *   workflow.harness.test.ts / mcp.harness.test.ts headers) because
 *   opencode-cli currently does not reliably scope to the spawn's cwd in this
 *   environment.
 * - opencode-cli uses its free big-pickle tier; claude-cli uses the haiku alias.
 *
 * Every file under src/test/harness/ reads this map — change models here only.
 */
export const HARNESS_MODELS: Record<HarnessId, string | undefined> = {
  "copilot-cli": "gpt-6-luna",
  "claude-cli": "haiku",
  "codex-cli": "gpt-6-luna",
  "opencode-cli": "opencode/big-pickle",
  "qwen-cli": "qwen3.5-plus",
  "antigravity-cli": "gemini-3.8-flash-low",
};

/**
 * CLI versions used when the inline-config behavior was verified.
 *
 * These are fixture pins, not a runtime upgrade mechanism.  The merge/layer
 * behavior covered by the tests is partly emergent, so it must be re-verified
 * whenever one of these harnesses is upgraded.
 */
export const PINNED_HARNESS_VERSIONS: Partial<Record<HarnessId, string>> = {
  "codex-cli": "0.146.0",
  "opencode-cli": "1.18.10",
  "qwen-cli": "0.20.1",
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

/** How the ctrlyoke CLI drives the harness for a run. */
type RunModeFlag = "--headless" | "--interactive";

/**
 * Serialise `workflow` to `<tmpDir>/<label>-test.ctrlyoke.json` and build the
 * `node cli.js run ...` argument list shared by every runner below.
 */
function prepareRun(
  workflow: PromptFile,
  tmpDir: string,
  label: string,
  modeFlag: RunModeFlag,
  vars: Record<string, string> | undefined,
  extraArgs: readonly string[] = []
): string[] {
  const workflowFile = path.join(tmpDir, `${label}-test.ctrlyoke.json`);
  fs.writeFileSync(workflowFile, JSON.stringify(workflow, null, 2));

  const varArgs: string[] = [];
  for (const [k, v] of Object.entries(vars ?? {})) {
    varArgs.push("--var", `${k}=${v}`);
  }

  return [
    CLI_PATH,
    "run",
    workflowFile,
    modeFlag,
    "--timeout",
    "180",
    ...extraArgs,
    ...varArgs,
  ];
}

function runPrepared(
  args: string[],
  tmpDir: string,
  timeoutMs: number
): RunResult {
  const result = spawnSync("node", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    cwd: tmpDir,
  });

  return {
    skipped: result.status === 3,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

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
  return runPrepared(
    prepareRun(workflow, tmpDir, label, "--headless", vars),
    tmpDir,
    timeoutMs
  );
}

/** A headless run that also carries the CLI's `--json` result. */
export interface JsonRunResult extends RunResult {
  /** Parsed `--json` result line; `undefined` when the CLI never printed one. */
  json: CliJsonResult | undefined;
}

/**
 * Headless run with `--json`, so a test can assert on per-step condition
 * verdicts (`passed`, `action`, `operator`, `actual`) instead of inferring
 * them from side effects.
 */
export function runWorkflowFileJson(
  workflow: PromptFile,
  tmpDir: string,
  label: string,
  vars?: Record<string, string>,
  timeoutMs: number = HARNESS_TIMEOUT_MS
): JsonRunResult {
  const result = runPrepared(
    prepareRun(workflow, tmpDir, label, "--headless", vars, ["--json"]),
    tmpDir,
    timeoutMs
  );
  return { ...result, json: parseJsonResultLine(result.stdout) };
}

/** The CLI emits its `--json` result as the last JSON line on stdout. */
function parseJsonResultLine(stdout: string): CliJsonResult | undefined {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as CliJsonResult;
    } catch {
      // Not the result line; keep looking.
    }
  }
  return undefined;
}

/**
 * Invoke a workflow through ctrlyoke's real interactive PTY path.
 *
 * The outer runner is still synchronous so each harness test remains isolated;
 * ctrlyoke creates the child PTY internally for the requested TUI execution.
 */
export function runInteractiveWorkflowFile(
  workflow: PromptFile,
  tmpDir: string,
  label: string,
  vars?: Record<string, string>,
  timeoutMs: number = HARNESS_TIMEOUT_MS
): RunResult {
  return runPrepared(
    prepareRun(workflow, tmpDir, label, "--interactive", vars),
    tmpDir,
    timeoutMs
  );
}

/**
 * Start a headless workflow without waiting for it, for concurrency fixtures.
 */
export function runWorkflowFileAsync(
  workflow: PromptFile,
  tmpDir: string,
  label: string,
  vars?: Record<string, string>,
  timeoutMs: number = HARNESS_TIMEOUT_MS
): Promise<RunResult> {
  const args = prepareRun(workflow, tmpDir, label, "--headless", vars);

  return new Promise<RunResult>((resolve) => {
    const child = spawn("node", args, {
      cwd: tmpDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        skipped: false,
        exitCode: null,
        stdout,
        stderr: String(error),
      });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        skipped: status === 3,
        exitCode: status,
        stdout,
        stderr,
      });
    });
  });
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
 * Source for a Node.js script that prints a file's content to stdout and exits
 * 0, or prints nothing and exits 1 when the file does not exist.
 *
 * Invocation: node read-file.js <filePath>
 *
 * Lets an end condition state its check with the real comparison trio
 * (`compareSource: stdout`, `operator: contains`, ...) against what the AI
 * actually wrote, instead of a wrapper script that pre-digests a verdict.
 */
export function buildReadFileScript(): string {
  return `"use strict";
const fs = require("fs");
const filePath = process.argv[2];
try {
  process.stdout.write(fs.readFileSync(filePath, "utf8"));
} catch {
  process.exit(1);
}
`;
}

/**
 * Source for a Node.js script that increments a counter file, prints the new
 * count, and exits 0 once the count reaches the threshold (default 2), or 1
 * before that.
 *
 * Invocation: node counter.js <counterFile> [threshold]
 *
 * Use-case: force exactly N-1 end-condition failures regardless of AI output,
 * to exercise the retry loop without depending on what the AI produces.
 */
export function buildCounterScript(): string {
  return `"use strict";
const fs = require("fs");
const counterFile = process.argv[2];
const threshold   = parseInt(process.argv[3] || "2", 10);
if (!counterFile) process.exit(2);
let count = 0;
try { count = parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) || 0; } catch {}
count++;
fs.writeFileSync(counterFile, String(count));
process.stdout.write(String(count));
process.exit(count >= threshold ? 0 : 1);
`;
}

/** What `buildEmitScript` writes and exits with. */
export interface EmitSpec {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/**
 * Source for a Node.js script that writes a fixed stdout/stderr and exits with
 * a fixed code, so a condition's comparison can be proven against known input.
 *
 * Invocation: `emitCommand(scriptPath, spec)` — the spec travels as base64 JSON
 * so no shell (cmd, pwsh, sh) gets a chance to re-quote the payload.
 */
export function buildEmitScript(): string {
  return `"use strict";
const spec = JSON.parse(Buffer.from(process.argv[2] || "", "base64").toString("utf8") || "{}");
if (spec.stdout) process.stdout.write(spec.stdout);
if (spec.stderr) process.stderr.write(spec.stderr);
process.exitCode = spec.exitCode || 0;
`;
}

/** The condition `script` line that runs `buildEmitScript` with `spec`. */
export function emitCommand(scriptPath: string, spec: EmitSpec): string {
  const payload = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
  return `node "${scriptPath}" ${payload}`;
}

/**
 * Source for a hook command that records its logical event immediately.
 * Permission hooks also emit the native decision payload expected by Codex,
 * Qwen, and OpenCode.
 */
export function buildHookRecorderScript(): string {
  return `"use strict";
const fs = require("fs");
const event = process.argv[2];
const outputFile = process.argv[3];
if (!event || !outputFile) process.exit(0);
fs.appendFileSync(outputFile, JSON.stringify({ event, ts: Date.now() }) + "\\n");
if (event === "permissionRequest") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" }
    }
  }));
}
`;
}

/**
 * Source for a tiny line-delimited MCP server used by the inline-config
 * regression cases.  It records each tool call, which lets a test prove that
 * two concurrent workflows did not expose one another's dynamic tool.
 */
export function buildMcpProbeServerScript(): string {
  return `"use strict";
const fs = require("fs");
const readline = require("readline");
const toolName = process.argv[2];
const markerFile = process.argv[3];
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    send(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "ctrlyoke-harness-probe", version: "1.0.0" }
    });
    return;
  }
  if (request.method === "tools/list") {
    send(request.id, {
      tools: [{
        name: toolName,
        description: "Record this isolated harness fixture tool call.",
        inputSchema: { type: "object", properties: {} }
      }]
    });
    return;
  }
  if (request.method === "tools/call") {
    if (request.params && request.params.name === toolName) {
      fs.appendFileSync(markerFile, toolName + "\\n");
      send(request.id, { content: [{ type: "text", text: "probe-called" }] });
    } else {
      send(request.id, { isError: true, content: [{ type: "text", text: "unknown tool" }] });
    }
  }
});
`;
}
