/**
 * Shared helpers for harness integration tests.
 *
 * Provides the CLI runner, model constants, and logging utilities used by
 * all files under src/test/harness/.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import * as nodePty from "node-pty";
import type { PromptFile } from "../../../types/CtrlYokeTypes";
import type { CliJsonResult } from "../../../cli/CliJsonResultBuilder";
import type { CliEvent, TextData } from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  type HarnessId,
} from "../../../types/DashboardConstants";
import { TIMELINE_EVENT_TYPES } from "../../../types/WorkflowTimelineTypes";
import { getCodexHomeDir } from "../../../utils/CodexHome";
import { makeTempDir } from "../../helpers/tempWorkspace";
import { projectStateRoot } from "../../../utils/ProjectStatePaths";
import { runsRootForProjectState } from "../../../utils/WorkflowPaths";

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
 * Folder-trust questions a harness TUI asks on first sight of a workspace, and
 * the keys that accept them. Matched against the terminal output with escape
 * sequences and whitespace removed. Only `makeHarnessWorkspaceDir`'s fixed
 * folders reach these, so each is answered once per machine.
 */
const FOLDER_TRUST_ANSWERS: readonly { prompt: RegExp; keys: string[] }[] = [
  // Claude Code: "Is this a project you created or one you trust?", with
  // "No, exit" selected above "Yes, I trust this folder".
  { prompt: /Yes,Itrustthisfolder/, keys: ["\x1b[B", "\r"] },
];

/** Pause before each answer keystroke: a TUI drops keys sent while it redraws. */
const ANSWER_KEY_DELAY_MS = 750;

/**
 * Invoke a workflow through ctrlyoke's interactive path, with ctrlyoke itself
 * running inside a real pseudo-terminal.
 *
 * The CLI's standalone interactive transport hands its own stdio straight to
 * the harness TUI, so the harness sees whatever terminal ctrlyoke was given. A
 * plain `spawnSync` gives it none: Codex 0.156 exits with "stdin is not a
 * terminal" and OpenCode's TUI waits forever on terminal queries. A PTY is
 * what a person running `ctrlyoke run --interactive` actually provides.
 */
export function runInteractiveWorkflowFile(
  workflow: PromptFile,
  tmpDir: string,
  label: string,
  vars?: Record<string, string>,
  timeoutMs: number = HARNESS_TIMEOUT_MS,
  /**
   * Polled every second; the run is killed as soon as it returns true. For a
   * case that ends waiting on a person, such as an unanswered approval prompt.
   */
  stopWhen?: () => boolean
): Promise<RunResult> {
  const args = prepareRun(workflow, tmpDir, label, "--interactive", vars);

  return new Promise<RunResult>((resolve) => {
    const terminal = nodePty.spawn(process.execPath, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: tmpDir,
      env: {
        ...process.env,
        PWD: tmpDir,
        TERM: "xterm-256color",
      } as Record<string, string>,
    });
    let output = "";
    let killed = false;
    const kill = () => {
      killed = true;
      terminal.kill();
    };
    const unanswered = [...FOLDER_TRUST_ANSWERS];
    terminal.onData((chunk) => {
      output += chunk;
      const screen = output
        .slice(-4000)
        .replace(/\x1b\[[0-9;?>]*[a-zA-Z]/g, "")
        .replace(/\s+/g, "");
      for (const answer of [...unanswered]) {
        if (answer.prompt.test(screen)) {
          unanswered.splice(unanswered.indexOf(answer), 1);
          answer.keys.forEach((key, index) =>
            setTimeout(
              () => terminal.write(key),
              (index + 1) * ANSWER_KEY_DELAY_MS
            )
          );
        }
      }
    });
    const timer = setTimeout(kill, timeoutMs);
    const poller = stopWhen
      ? setInterval(() => {
          if (stopWhen()) kill();
        }, 1000)
      : undefined;
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      clearInterval(poller);
      resolve({
        skipped: !killed && exitCode === 3,
        // Mirror spawnSync: a killed run has no exit code.
        exitCode: killed ? null : exitCode,
        // A PTY merges both streams into one.
        stdout: output,
        stderr: "",
      });
    });
  });
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
// Codex home isolation
// ---------------------------------------------------------------------------

/**
 * Run `fn` with `CODEX_HOME` pointing at a throwaway Codex home in which each
 * of `trustedDirs` is a trusted project.
 *
 * Interactive Codex (0.156+) opens a "Trust this folder?" dialog for every
 * folder it has not recorded, and reads that decision only from
 * `<CODEX_HOME>/config.toml` (a `-c projects.…trust_level` override is
 * ignored). Test folders are fresh temp directories, so without this every
 * interactive run would stall on the dialog, and answering it would append a
 * dead temp path to the developer's real `~/.codex/config.toml`.
 *
 * The real home is only read: `auth.json` and `config.toml` are copied so the
 * isolated home authenticates and behaves like the developer's own.
 */
export async function withIsolatedCodexHome<T>(
  trustedDirs: readonly string[],
  fn: () => Promise<T>
): Promise<T> {
  const realHome = getCodexHomeDir();
  // Codex refuses to create its PATH helper aliases when CODEX_HOME itself is
  // under the Windows temp directory. Keep the isolated home under the user's
  // home directory, where it is still unique and removed after the case.
  const isolatedHome = fs.mkdtempSync(
    path.join(os.homedir(), ".cy-codex-home-")
  );
  for (const file of ["auth.json", "config.toml"]) {
    const source = path.join(realHome, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(isolatedHome, file));
    }
  }
  // TOML literal-string keys hold a Windows path without escaping, matching
  // how Codex itself records trust.
  const trustEntries = trustedDirs
    .map((dir) => `\n[projects.'${dir}']\ntrust_level = "trusted"\n`)
    .join("");
  fs.appendFileSync(path.join(isolatedHome, "config.toml"), trustEntries);

  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = isolatedHome;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousHome;
    }
    fs.rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ---------------------------------------------------------------------------
// Workspace and run-state fixtures
// ---------------------------------------------------------------------------

/** Set to keep each case's workspace after the run, for inspection. */
export const KEEP_WORKSPACES_ENV = "CTRLYOKE_HARNESS_KEEP_WORKSPACES";

/**
 * Harnesses whose TUI asks "do you trust this folder?" for a folder it has not
 * seen, and records the answer per path in the user's own config. Their
 * workspaces reuse one fixed path, so the question is answered once
 * (`FOLDER_TRUST_ANSWERS`) instead of adding a dead temp path to that config
 * on every run. Codex gets an isolated home instead (`withIsolatedCodexHome`).
 */
const FIXED_WORKSPACE_HARNESSES: ReadonlySet<HarnessId> = new Set([
  "claude-cli",
]);

/**
 * An empty workspace folder for one case: a fresh temp folder, or the
 * harness's fixed folder emptied. Remove it with `removeTempDir`.
 */
export function makeHarnessWorkspaceDir(
  harness: HarnessId,
  prefix: string
): string {
  if (!FIXED_WORKSPACE_HARNESSES.has(harness)) return makeTempDir(prefix);
  const dir = path.join(os.tmpdir(), `ctrlyoke-harness-${harness}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(dir);
  return dir;
}

/**
 * Make `dir` the root of its own git repository. Copilot discovers hooks under
 * the repository root's `.github/hooks/`, so without this a temp folder inside
 * some other checkout would put ctrlyoke's hook file in the wrong place.
 */
export function initGitRepo(dir: string): void {
  const result = spawnSync("git", ["init", "--quiet"], {
    cwd: dir,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`git init failed in ${dir}`);
  }
}

/**
 * Point `CTRLYOKE_HOME` at `<tmpDir>/state` until the returned restore
 * function runs, so each case's run history is its own and can be read back.
 */
export function isolateRunState(tmpDir: string): () => void {
  const prior = process.env.CTRLYOKE_HOME;
  process.env.CTRLYOKE_HOME = path.join(tmpDir, "state");
  return () => {
    if (prior === undefined) delete process.env.CTRLYOKE_HOME;
    else process.env.CTRLYOKE_HOME = prior;
  };
}

/** Run storage of a workspace whose state was isolated by `isolateRunState`. */
export function runsRootFor(workspace: string): string {
  return runsRootForProjectState(projectStateRoot(workspace, "user"));
}

/** Every file named `fileName` under `directory`, depth first. */
export function findRunFiles(directory: string, fileName: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findRunFiles(fullPath, fileName);
    return entry.name === fileName ? [fullPath] : [];
  });
}

/** The CLI events a run recorded in its `events.jsonl` timeline. */
export function readRecordedCliEvents(eventsPath: string): CliEvent[] {
  const cliEvents: CliEvent[] = [];
  for (const line of fs.readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const event = JSON.parse(line) as {
      eventType?: string;
      payload?: {
        cliOutput?: { events?: CliEvent[] };
        events?: CliEvent[];
      };
    };
    if (event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED) {
      cliEvents.push(...(event.payload?.cliOutput?.events ?? []));
    } else if (
      event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED
    ) {
      cliEvents.push(...(event.payload?.events ?? []));
    }
  }
  return cliEvents;
}

/** All AI response text recorded for the runs under `workspace`. */
export function readResponseText(workspace: string): string {
  return findRunFiles(runsRootFor(workspace), "events.jsonl")
    .flatMap(readRecordedCliEvents)
    .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
    .map((event) => (event.data as TextData).text)
    .join("\n");
}

/** The logical hook events `buildHookRecorderScript` wrote to `outputPath`. */
export function readRecordedHookEvents(outputPath: string): Set<string> {
  if (!fs.existsSync(outputPath)) return new Set();
  return new Set(
    fs
      .readFileSync(outputPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { event: string }).event)
  );
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
 * and capability cases.  It records each tool call, which lets a test prove
 * that two concurrent workflows did not expose one another's dynamic tool, or
 * that a denied tool was never called.
 *
 * Invocation: node mcp-probe.js <toolName>[,<toolName>...] <markerFile>
 */
export function buildMcpProbeServerScript(): string {
  return `"use strict";
const fs = require("fs");
const readline = require("readline");
const toolNames = process.argv[2].split(",");
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
      tools: toolNames.map((name) => ({
        name,
        description: "Record this isolated harness fixture tool call.",
        inputSchema: { type: "object", properties: {} }
      }))
    });
    return;
  }
  if (request.method === "tools/call") {
    if (request.params && toolNames.includes(request.params.name)) {
      fs.appendFileSync(markerFile, request.params.name + "\\n");
      send(request.id, { content: [{ type: "text", text: "probe-called" }] });
    } else {
      send(request.id, { isError: true, content: [{ type: "text", text: "unknown tool" }] });
    }
    return;
  }
  // Every other request gets a JSON-RPC error, as a real server would send.
  // Qwen 0.24 asks for prompts/list and resources/list even though only
  // tools are advertised, and marks the server "failed to start" when those
  // go unanswered. Notifications (no id) need no reply.
  if (request.id !== undefined) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found" }
    }) + "\\n");
  }
});
`;
}
