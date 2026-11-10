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
import {
  HARNESS_HOME_ENV_VARS,
  getClaudeConfigDir,
  getClaudeGlobalConfigPath,
  getCodexHomeDir,
  getCopilotHomeDir,
  getQwenHomeDir,
} from "../../../utils/HarnessHome";
import { makeTempDir } from "../../helpers/tempWorkspace";
import { projectStateRoot } from "../../../utils/ProjectStatePaths";
import { runsRootForProjectState } from "../../../utils/WorkflowPaths";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the compiled CLI binary (resolved relative to the compiled output). */
const CLI_PATH = path.resolve(__dirname, "../../../cli.js");

/**
 * Per-prompt timeout, in seconds, passed to `ctrlyoke run --timeout`.
 *
 * These tests are correctness checks, not performance checks: the cheap models
 * in {@link HARNESS_MODELS} can be slow, and a slow model that gets there must
 * not fail a case. A model that is stuck still ends at this limit.
 */
const PROMPT_TIMEOUT_SECONDS = 3600; // 1 hour

/**
 * Wall-clock timeout in ms for one test and for each ctrlyoke CLI process it
 * spawns. It leaves room above {@link PROMPT_TIMEOUT_SECONDS} for a second
 * step, a retry, or an MCP-appended step.
 */
export const HARNESS_TIMEOUT_MS = 7_200_000; // 2 hours

/**
 * Appended to every prompt that calls an MCP tool. Several harnesses (agy,
 * OpenCode 2.2.5) can start the first turn before their MCP servers finish
 * connecting, and a model that sees no tool then reports it as missing.
 */
export const MCP_STARTUP_WAIT_INSTRUCTION =
  "MCP servers can take up to a minute to load. If an MCP tool named here is not available yet, wait up to one minute for it to appear before deciding it is unavailable.";

export type { HarnessId };

/**
 * Model per harness — the cheapest tier of the current generation, so a run
 * exercises what users actually pick without paying for a flagship model.
 * - copilot-cli remains the default for tool-execution-dependent tests (see
 *   workflow.harness.test.ts / mcp.harness.test.ts headers) because
 *   opencode-cli currently does not reliably scope to the spawn's cwd in this
 *   environment.
 * - opencode-cli uses Claude Haiku through OpenCode Zen, a paid model: the free
 *   big-pickle tier has a usage cap that a full suite run can exhaust, after
 *   which every OpenCode case times out. claude-cli uses the haiku alias.
 * - antigravity-cli uses Gemini 3.8 Flash (Medium), which needs a paid Google
 *   plan: on the free plan two full runs exhaust the weekly quota. GPT-OSS
 *   120B, the cheaper alternative, stalled for 5 minutes per request in
 *   November 2026, timing out every case.
 * - qwen-cli uses qwen3.7-flash: cheaper than qwen3.6-plus, and it follows
 *   the suite's tool instructions where qwen3.5-flash did not (it skipped
 *   commands and repeated MCP calls). The test machine's
 *   `~/.qwen/settings.json` must list it under `modelProviders`, or ctrlyoke
 *   fails every Qwen step before launch (Qwen 0.27+ would silently run its
 *   default model).
 *
 * `CTRLYOKE_HARNESS_MODEL_<HARNESS>` (e.g. `CTRLYOKE_HARNESS_MODEL_ANTIGRAVITY_CLI`)
 * replaces a harness's model for a whole run, image cases included — for an
 * occasional full check on the model most users pick.
 *
 * Every file under src/test/harness/ reads this map — change models here only.
 */
export const HARNESS_MODELS: Record<HarnessId, string | undefined> = {
  "copilot-cli": modelFor("copilot-cli", "gpt-6-luna"),
  "claude-cli": modelFor("claude-cli", "haiku"),
  "codex-cli": modelFor("codex-cli", "gpt-6-luna"),
  "opencode-cli": modelFor("opencode-cli", "opencode/claude-haiku-5-5"),
  "qwen-cli": modelFor("qwen-cli", "qwen3.7-flash"),
  "antigravity-cli": modelFor("antigravity-cli", "gemini-3.8-flash-medium"),
};

/**
 * Models for cases that send an image, where a harness's default model cannot
 * read one. A harness not listed here uses its {@link HARNESS_MODELS} entry.
 */
export const HARNESS_IMAGE_MODELS: Partial<Record<HarnessId, string>> = {};

/** The model a case that sends an image should run `harness` with. */
export function imageInputModel(harness: HarnessId): string | undefined {
  return HARNESS_IMAGE_MODELS[harness] ?? HARNESS_MODELS[harness];
}

/** `fallback`, unless `CTRLYOKE_HARNESS_MODEL_<HARNESS>` names another model. */
function modelFor(harness: HarnessId, fallback: string): string {
  const envName = `CTRLYOKE_HARNESS_MODEL_${harness.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envName]?.trim() || fallback;
}

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
    String(PROMPT_TIMEOUT_SECONDS),
    ...extraArgs,
    ...varArgs,
  ];
}

// ---------------------------------------------------------------------------
// Transient-failure retry
// ---------------------------------------------------------------------------

/** Retries after the first attempt when the harness reports a transient error. */
const TRANSIENT_RETRY_LIMIT = 3;
/** Wait before each retry; capacity errors usually clear within a minute or two. */
const TRANSIENT_RETRY_DELAY_MS = 90_000;

/**
 * agy prints `AGY_ERROR: {...}` when a request fails, with `"retryable": true`
 * for server-side errors such as `UNAVAILABLE (code 503): No capacity
 * available for model ...`. Only that flag triggers a retry, so a model or
 * ctrlyoke failure still fails the case on its first attempt.
 */
const AGY_ERROR_LINE = /AGY_ERROR: (\{[^\r\n]*\})/g;

function isTransientHarnessFailure(result: RunResult): boolean {
  if (result.skipped || result.exitCode === 0) return false;
  for (const match of `${result.stdout}\n${result.stderr}`.matchAll(
    AGY_ERROR_LINE
  )) {
    try {
      if ((JSON.parse(match[1]) as { retryable?: unknown }).retryable === true)
        return true;
    } catch {
      // Not a complete JSON object; ignore this line.
    }
  }
  return false;
}

/**
 * The run lineages under `tmpDir` created for `label` (workflow file
 * `<label>-test.ctrlyoke.json`, lineage `<label>-test-<timestamp>`).
 */
function runLineagesFor(tmpDir: string, label: string): Set<string> {
  const root = runsRootFor(tmpDir);
  if (!fs.existsSync(root)) return new Set();
  const prefix = `${label}-test-`;
  return new Set(
    fs
      .readdirSync(root)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(root, name))
  );
}

/**
 * Decide whether to retry `result`. When it does, the failed attempt's run
 * lineage is deleted first, so a case that reads `events.jsonl` sees only the
 * attempt that finished. Matching by label keeps concurrent runs in the same
 * workspace apart.
 */
function prepareTransientRetry(
  result: RunResult,
  retry: number,
  tmpDir: string,
  label: string,
  before: ReadonlySet<string>
): boolean {
  if (retry >= TRANSIENT_RETRY_LIMIT || !isTransientHarnessFailure(result)) {
    return false;
  }
  for (const lineage of runLineagesFor(tmpDir, label)) {
    if (!before.has(lineage))
      fs.rmSync(lineage, { recursive: true, force: true });
  }
  console.log(
    `  ↻  ${label}: transient harness error, retry ${retry + 1}/${TRANSIENT_RETRY_LIMIT} in ${TRANSIENT_RETRY_DELAY_MS / 1000}s`
  );
  return true;
}

/** Run `attempt`, retrying while it fails with a transient harness error. */
function withTransientRetry(
  tmpDir: string,
  label: string,
  attempt: () => RunResult
): RunResult {
  for (let retry = 0; ; retry++) {
    const before = runLineagesFor(tmpDir, label);
    const result = attempt();
    if (!prepareTransientRetry(result, retry, tmpDir, label, before)) {
      return result;
    }
    // A synchronous wait: the sync runner's callers are synchronous tests.
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      TRANSIENT_RETRY_DELAY_MS
    );
  }
}

/** {@link withTransientRetry} for runners that return a promise. */
async function withTransientRetryAsync(
  tmpDir: string,
  label: string,
  attempt: () => Promise<RunResult>
): Promise<RunResult> {
  for (let retry = 0; ; retry++) {
    const before = runLineagesFor(tmpDir, label);
    const result = await attempt();
    if (!prepareTransientRetry(result, retry, tmpDir, label, before)) {
      return result;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS)
    );
  }
}

function runPrepared(
  args: string[],
  tmpDir: string,
  label: string,
  timeoutMs: number
): RunResult {
  return withTransientRetry(tmpDir, label, () => {
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
  });
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
    label,
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
    label,
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
 * sequences and whitespace removed. Claude's comes up only for
 * `makeHarnessWorkspaceDir`'s fixed folders, so it is answered once per
 * machine. Copilot's comes up for every fresh temp folder; its default answer
 * trusts the folder for that session only and records nothing, so it is
 * answered every time it appears (a resumed step asks again).
 */
const FOLDER_TRUST_ANSWERS: readonly {
  prompt: RegExp;
  keys: string[];
  /** Answer each time the question appears, not just the first time. */
  repeats?: boolean;
}[] = [
  // Claude Code: "Is this a project you created or one you trust?", with
  // "No, exit" selected above "Yes, I trust this folder".
  { prompt: /Yes,Itrustthisfolder/, keys: ["\x1b[B", "\r"] },
  // Copilot CLI: "Do you trust the files in this folder?", with "1. Yes"
  // (this session only) selected above "Yes, and remember this folder". The
  // dialog's box border (`│`) separates the question from its options.
  {
    prompt: /Doyoutrustthefilesinthisfolder\?[│]*❯1\.Yes/,
    keys: ["\r"],
    repeats: true,
  },
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

  return withTransientRetryAsync(tmpDir, label, () =>
    spawnInteractive(args, tmpDir, timeoutMs, stopWhen)
  );
}

/** One interactive attempt of {@link runInteractiveWorkflowFile}. */
function spawnInteractive(
  args: string[],
  tmpDir: string,
  timeoutMs: number,
  stopWhen: (() => boolean) | undefined
): Promise<RunResult> {
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
    // Output before this offset has already been answered, so a repeating
    // answer only fires again for a question asked after its last reply. No
    // question is matched while a reply's keys are still being sent, because
    // the TUI keeps redrawing the question until the last key arrives.
    let answeredThrough = 0;
    let replying = false;
    terminal.onData((chunk) => {
      output += chunk;
      if (replying) return;
      const screen = output
        .slice(Math.max(answeredThrough, output.length - 4000))
        .replace(/\x1b\[[0-9;?>]*[a-zA-Z]/g, "")
        .replace(/\s+/g, "");
      const answer = unanswered.find((candidate) =>
        candidate.prompt.test(screen)
      );
      if (!answer) return;
      if (!answer.repeats) unanswered.splice(unanswered.indexOf(answer), 1);
      replying = true;
      answer.keys.forEach((key, index) =>
        setTimeout(
          () => {
            terminal.write(key);
            if (index === answer.keys.length - 1) {
              answeredThrough = output.length;
              replying = false;
            }
          },
          (index + 1) * ANSWER_KEY_DELAY_MS
        )
      );
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

  return withTransientRetryAsync(tmpDir, label, () =>
    spawnHeadless(args, tmpDir, timeoutMs)
  );
}

/** One attempt of {@link runWorkflowFileAsync}. */
function spawnHeadless(
  args: string[],
  tmpDir: string,
  timeoutMs: number
): Promise<RunResult> {
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
// Harness home isolation
// ---------------------------------------------------------------------------

/** An environment variable a harness CLI reads to move its home directory. */
export type HarnessHomeEnvVar =
  (typeof HARNESS_HOME_ENV_VARS)[keyof typeof HARNESS_HOME_ENV_VARS];

export interface MovedHarnessHomeOptions {
  /** The variable that moves the home, set for the duration of `fn`. */
  readonly variable: HarnessHomeEnvVar;
  /**
   * Files of the developer's real home to copy in (sign-in, settings), as
   * `name inside the moved home` → `absolute source path`. Missing sources
   * are skipped. The real files are only read.
   */
  readonly copy: Readonly<Record<string, string>>;
  /** Folder to create the moved home in; the OS temp folder by default. */
  readonly parentDir?: string;
}

/** Copy the named files of `realHome` into a moved home under the same names. */
function copyFromHome(
  realHome: string,
  files: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [file, path.join(realHome, file)])
  );
}

/**
 * A moved Claude home (`CLAUDE_CONFIG_DIR`) signed in as the developer. The
 * moved home also holds `.claude.json` (onboarding state, folder trust), which
 * otherwise lives beside `~/.claude`.
 */
export function claudeHomeCopy(): MovedHarnessHomeOptions {
  return {
    variable: HARNESS_HOME_ENV_VARS.CLAUDE_CONFIG_DIR,
    copy: {
      ...copyFromHome(getClaudeConfigDir(), [
        ".credentials.json",
        "settings.json",
      ]),
      ".claude.json": getClaudeGlobalConfigPath(),
    },
  };
}

/** A moved Qwen home (`QWEN_HOME`) that can sign in and pick its model. */
export function qwenHomeCopy(): MovedHarnessHomeOptions {
  return {
    variable: HARNESS_HOME_ENV_VARS.QWEN_HOME,
    copy: copyFromHome(getQwenHomeDir(), [
      "settings.json",
      "oauth_creds.json",
      "installation_id",
    ]),
  };
}

/**
 * A moved Copilot home (`COPILOT_HOME`). `config.json` names the signed-in
 * account, whose token stays in the OS credential store, and the trusted
 * folders.
 */
export function copilotHomeCopy(): MovedHarnessHomeOptions {
  return {
    variable: HARNESS_HOME_ENV_VARS.COPILOT_HOME,
    copy: copyFromHome(getCopilotHomeDir(), ["config.json", "settings.json"]),
  };
}

/**
 * Run `fn` with `options.variable` pointing at a throwaway home directory.
 * The ctrlyoke CLI the case starts inherits `process.env`, and so does the
 * harness it spawns, so both resolve the same moved home.
 */
export async function withMovedHarnessHome<T>(
  options: MovedHarnessHomeOptions,
  fn: (home: string) => T | Promise<T>
): Promise<T> {
  const home = fs.mkdtempSync(
    path.join(options.parentDir ?? os.tmpdir(), ".cy-harness-home-")
  );
  for (const [name, source] of Object.entries(options.copy)) {
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(home, name));
    }
  }
  const previous = process.env[options.variable];
  process.env[options.variable] = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) {
      delete process.env[options.variable];
    } else {
      process.env[options.variable] = previous;
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

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
  return withMovedHarnessHome(
    {
      variable: HARNESS_HOME_ENV_VARS.CODEX_HOME,
      copy: {
        "auth.json": path.join(realHome, "auth.json"),
        "config.toml": path.join(realHome, "config.toml"),
      },
      // Codex refuses to create its PATH helper aliases when CODEX_HOME itself
      // is under the Windows temp directory. Keep the isolated home under the
      // user's home directory, where it is still unique and removed after the
      // case.
      parentDir: os.homedir(),
    },
    (isolatedHome) => {
      // TOML literal-string keys hold a Windows path without escaping, matching
      // how Codex itself records trust. Codex looks the folder up by its real
      // path, so a macOS temp folder (`/var/folders/…`, a symlink into
      // `/private/var/…`) is recorded under both spellings.
      const trustEntries = [
        ...new Set(trustedDirs.flatMap((dir) => [dir, fs.realpathSync(dir)])),
      ]
        .map((dir) => `\n[projects.'${dir}']\ntrust_level = "trusted"\n`)
        .join("");
      fs.appendFileSync(path.join(isolatedHome, "config.toml"), trustEntries);
      return fn();
    }
  );
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
      const recorded = process.argv[4]
        ? process.env[process.argv[4]]
        : request.params.name;
      fs.appendFileSync(markerFile, String(recorded || "") + "\\n");
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
