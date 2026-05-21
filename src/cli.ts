import { Command } from "commander";
import chalk from "chalk";
import * as path from "path";
import * as crypto from "crypto";
import * as readline from "readline";
import { access } from "fs/promises";

import { CliAdapter } from "./platform/CliAdapter";
import type { ResolvedCliConfig } from "./platform/CliAdapter";
import { registerCliAdapter } from "./platform/vscode-shim";
import { IntegrationFactory } from "./flightpath/IntegrationFactory";
import { WorkflowInstance } from "./flightpath/WorkflowInstance";
import {
  EXECUTION_STATES,
  STEP_STATUS,
  HARNESS_IDS,
  EXECUTION_MODES,
  PERMISSION_MODES,
  RUNNER_IDS,
} from "./types/DashboardConstants";
import type {
  ExecutionMode,
  HarnessId,
  PermissionMode,
} from "./types/DashboardConstants";
import { isScriptStep } from "./types/FlightPathTypes";
import { configService } from "./config/FlightPathConfigService";
import {
  createUserConfigBackend,
  createWorkspaceConfigBackend,
} from "./config/FileConfigBackend";
import type { PartialFlightPathSettings } from "./types/FlightPathSettings";
import type { QueueState, WorkflowRunnerLock } from "./types/FlightPathTypes";
import { CliTerminalFormatter } from "./cli/CliTerminalFormatter";
import { Log } from "./utils/Log";
import { WorkflowLockManager } from "./utils/WorkflowLockManager";
import { setRuntimeMode } from "./utils/RuntimeMode";

// Mark this process as the standalone CLI binary before anything else runs.
setRuntimeMode(RUNNER_IDS.CLI);

// VERSION is injected by esbuild define
declare const VERSION: string;
const version = typeof VERSION !== "undefined" ? VERSION : "0.0.0-dev";

const program = new Command();

program
  .name("flightpath")
  .description("Execute AI-powered workflow automation from the command line")
  .version(version);

program
  .command("run [file]")
  .description("Execute a prompt or workflow file")
  .option(
    "-H, --harness <harness>",
    "AI harness: copilot-cli, claude-cli, codex-cli",
    HARNESS_IDS.COPILOT_CLI
  )
  .option("-m, --model <model>", "Model to use")
  .option(
    "-d, --cwd <path>",
    "Working directory (default: directory of prompt file)"
  )
  .option("-t, --timeout <seconds>", "Global timeout in seconds", "3600")
  .option("--script-timeout <seconds>", "End condition script timeout", "30")
  .option("--headless", "Force headless mode (CI/CD, no user interaction)")
  .option(
    "--interactive",
    "Force interactive mode (TUI passthrough, user controls session end)"
  )
  .option(
    "--allow-tool <pattern>",
    "Allow specific tool pattern (repeatable)",
    collectRepeatable,
    [] as string[]
  )
  .option(
    "--deny-tool <pattern>",
    "Deny specific tool pattern (repeatable)",
    collectRepeatable,
    [] as string[]
  )
  .option(
    "--permission-mode <mode>",
    "Tool permission mode: dangerouslyAllowAll, allowAll, custom (default: auto-detect)"
  )
  .option(
    "--add-dir <path>",
    "Add directory to Copilot CLI allowed paths (repeatable)",
    collectRepeatable,
    [] as string[]
  )
  .option(
    "--var <assignment>",
    "Variable substitution: key=value (repeatable). Replaces {{key}} in prompt text, model, hooks, and endCondition.",
    collectVar,
    {} as Record<string, string>
  )
  .option("-p, --prompt <text>", "Inline prompt string (alternative to file)")
  .option(
    "--session-id <id>",
    "Session ID to resume (implies --resume-session)"
  )
  .option(
    "--[no-]resume-session",
    "Override resumeSession: --resume-session forces resume, --no-resume-session forces new session"
  )
  .option("--json", "Output results as JSON")
  .option("-q, --quiet", "Suppress all output except errors")
  .option("--verbose", "Show debug information")
  .option("--no-color", "Disable colored output")
  .action(async (file: string | undefined, options: RunOptions) => {
    await runCommand(file, options);
  });

program
  .command("validate <file>")
  .description("Validate a prompt file without executing it")
  .action(async (file: string) => {
    await validateCommand(file);
  });

program
  .command("commit")
  .description("Generate an AI-powered commit message and commit")
  .option("-m, --model <model>", "Override model for commit message generation")
  .option("-d, --cwd <path>", "Working directory (default: current directory)")
  .option(
    "--hint <text>",
    "Extra instructions or starting draft to guide the generated message"
  )
  .option(
    "--print-only",
    "Print the generated message to stdout without committing"
  )
  .option("-y, --yes", "Skip confirmation prompt and commit automatically")
  .action(async (options: CommitCommandOptions) => {
    await commitCommand(options);
  });

program.parse();

// ---- Types ----

interface RunOptions {
  harness: string;
  model?: string;
  cwd?: string;
  timeout: string;
  scriptTimeout: string;
  headless?: boolean;
  interactive?: boolean;
  allowTool: string[];
  denyTool: string[];
  permissionMode?: string;
  addDir: string[];
  var: Record<string, string>;
  prompt?: string;
  sessionId?: string;
  resumeSession?: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectVar(
  value: string,
  previous: Record<string, string>
): Record<string, string> {
  const eqIndex = value.indexOf("=");
  if (eqIndex === -1) {
    console.error(
      chalk.red(`Error: --var "${value}" must be in key=value format`)
    );
    process.exit(2);
  }
  return {
    ...previous,
    [value.slice(0, eqIndex)]: value.slice(eqIndex + 1),
  };
}

/**
 * Determine execution mode from CLI flags and TTY detection.
 *
 * Precedence:
 *   1. --headless flag  → always headless
 *   2. --interactive flag → always interactive
 *   3. TTY detection: both stdout AND stdin are a TTY → interactive (default for terminal users)
 *   4. Otherwise → headless (CI/CD, pipes, redirects)
 */
function getExecutionMode(
  options: Pick<RunOptions, "headless" | "interactive">
): ExecutionMode {
  if (options.headless) return EXECUTION_MODES.HEADLESS;
  if (options.interactive) return EXECUTION_MODES.INTERACTIVE;
  return process.stdout.isTTY && process.stdin.isTTY
    ? EXECUTION_MODES.INTERACTIVE
    : EXECUTION_MODES.HEADLESS;
}

// ---- Commands ----

async function runCommand(
  file: string | undefined,
  options: RunOptions
): Promise<void> {
  if (options.color === false) {
    process.env.NO_COLOR = "1";
  }

  if (!file && !options.prompt) {
    console.error(
      chalk.red("Error: Provide a file argument or --prompt <text>")
    );
    process.exit(2);
  }
  if (file && options.prompt) {
    console.error(
      chalk.red("Error: --prompt cannot be used together with a file argument")
    );
    process.exit(2);
  }

  const resolvedFile = file ? path.resolve(file) : undefined;
  const workingDir = options.cwd ?? process.cwd();

  // Redirect all Log.* output to .flightpath/logs/flightpath-<timestamp>.log.
  // Must be called before any component code that calls Log.debug/info/etc.,
  // so that diagnostic messages never pollute the terminal output.
  Log.initializeCli(workingDir, options.verbose);

  // Detect execution mode: explicit flags override TTY auto-detection
  const executionMode = getExecutionMode(options);

  // In headless mode, auto-apply dangerouslyAllowAll unless the user specified
  // custom allow/deny lists (which imply deliberate control).
  const hasCustomTools =
    (options.allowTool && options.allowTool.length > 0) ||
    (options.denyTool && options.denyTool.length > 0);
  const permissionMode: PermissionMode = options.permissionMode
    ? (options.permissionMode as PermissionMode)
    : hasCustomTools
      ? PERMISSION_MODES.CUSTOM
      : executionMode === EXECUTION_MODES.HEADLESS
        ? PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL
        : PERMISSION_MODES.ALLOW_ALL;

  const config: ResolvedCliConfig = {
    harness: options.harness || HARNESS_IDS.COPILOT_CLI,
    model: options.model,
    cwd: workingDir,
    timeout: parseInt(options.timeout, 10) * 1000,
    scriptTimeout: parseInt(options.scriptTimeout, 10) * 1000,
    permissionMode,
    allowedTools: options.allowTool || [],
    deniedTools: options.denyTool || [],
    additionalDirs: options.addDir || [],
    vars: options.var || {},
    sessionId: options.sessionId,
    resumeSession: options.resumeSession,
    verbose: options.verbose ?? false,
    quiet: options.quiet ?? false,
    json: options.json ?? false,
    color: options.color !== false,
    headless: options.headless,
    cliExecutionMode: executionMode,
  };

  // Initialize config service with file-based backends so that settings from
  // ~/.flightpath/settings.json and <workspace>/.flightpath/settings.json are
  // resolved before applying the CLI overlay below.
  const userBackend = createUserConfigBackend();
  const workspaceBackend = createWorkspaceConfigBackend(workingDir);
  configService.setUserBackend(userBackend);
  configService.setWorkspaceBackend(workspaceBackend);

  // Build CLI overlay from explicitly provided flags only (not Commander defaults).
  const overlay: PartialFlightPathSettings = {};
  // --harness: only include when not the default (copilot-cli)
  if (options.harness && options.harness !== HARNESS_IDS.COPILOT_CLI) {
    overlay.defaults = { harness: options.harness as HarnessId };
  }
  if (options.model) {
    overlay.defaults = {
      ...overlay.defaults,
      models: { [config.harness as HarnessId]: options.model },
    };
  }
  if (options.headless) {
    overlay.execution = { mode: "headless" };
  } else if (options.interactive) {
    overlay.execution = { mode: "interactive" };
  } else {
    // Write TTY-detected execution mode to the overlay so that
    // ConfigurationUtils.getCliExecutionMode() always returns the effective value
    // regardless of what the user's config file says.
    overlay.execution = { mode: executionMode };
  }
  if (options.permissionMode) {
    overlay.defaults = {
      ...overlay.defaults,
      toolPermissions: {
        mode: options.permissionMode as
          | "dangerouslyAllowAll"
          | "allowAll"
          | "custom",
      },
    };
  }
  if (options.allowTool?.length) {
    overlay.defaults = {
      ...overlay.defaults,
      toolPermissions: {
        ...(overlay.defaults?.toolPermissions ?? {}),
        allowedTools: options.allowTool,
      },
    };
  }
  if (options.denyTool?.length) {
    overlay.defaults = {
      ...overlay.defaults,
      toolPermissions: {
        ...(overlay.defaults?.toolPermissions ?? {}),
        deniedTools: options.denyTool,
      },
    };
  }
  configService.setCliOverlay(overlay);

  const platform = new CliAdapter(config);
  // Register the adapter with the vscode-shim for backward compatibility.
  registerCliAdapter(platform);
  const factory = new IntegrationFactory(platform);
  const harness = config.harness as HarnessId;

  if (options.verbose) {
    console.log(
      chalk.dim(
        `[verbose] Execution mode: ${executionMode} (TTY: stdout=${!!process.stdout.isTTY} stdin=${!!process.stdin.isTTY})`
      )
    );
    console.log(chalk.dim(`[verbose] Harness: ${config.harness}`));
    if (config.model) {
      console.log(chalk.dim(`[verbose] Model: ${config.model}`));
    }
    console.log(chalk.dim(`[verbose] Workspace root: ${workingDir}`));
    const varEntries = Object.entries(config.vars);
    if (varEntries.length > 0) {
      console.log(
        chalk.dim(
          `[verbose] Vars: ${varEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`
        )
      );
    }
  }

  if (!options.quiet && !options.json) {
    if (executionMode === EXECUTION_MODES.INTERACTIVE) {
      // FlightPath header minimal so it doesn't clutter the user's session.
      console.log(
        chalk.dim(
          `FlightPath v${version} — starting ${chalk.yellow(config.harness)} in interactive mode…`
        )
      );
      console.log();
    } else {
      console.log(chalk.bold(`FlightPath CLI v${version}`));
      console.log(chalk.dim("━".repeat(52)));
      console.log();
      console.log(
        `Running: ${chalk.cyan(resolvedFile ? path.basename(resolvedFile) : "<inline prompt>")}`
      );
      console.log(
        `Harness: ${chalk.yellow(config.harness)}${config.model ? chalk.dim(" (" + config.model + ")") : ""}`
      );
      console.log(chalk.dim("─".repeat(52)));
    }
  }

  // Create a cached detector integration (pre-marked as ready, used for pre-flight checks)
  const detectorIntegration = factory.createForExecution(harness);

  const instance = new WorkflowInstance(
    platform,
    undefined, // no dashboard sink in CLI
    factory,
    (_harnessOverride?: HarnessId) => detectorIntegration,
    (_name: string | undefined) => {}, // no tab management
    () => {}, // no status bar update
    workingDir
  );

  // In headless mode, stream output to the terminal as events arrive.
  // Subscriptions go on the instance (not detectorIntegration) because WorkflowInstance
  // creates a fresh execution integration via the factory and forwards events from it.
  // Interactive mode passes the AI CLI's stdout straight through — no subscription needed.
  if (
    executionMode === EXECUTION_MODES.HEADLESS &&
    !options.quiet &&
    !options.json
  ) {
    instance.onPromptStart((data) => {
      CliTerminalFormatter.renderPromptHeader(data);
    });
    instance.onStreamingEvents((events) => {
      CliTerminalFormatter.renderEvents(events);
    });
    instance.onStreamingChunk((chunk) => {
      process.stdout.write(chunk);
    });
    instance.onWorkflowStatusMessage((data) => {
      CliTerminalFormatter.renderStatusMessage(data.message, data.severity);
    });
    instance.onPromptComplete((data) => {
      CliTerminalFormatter.flushStreamingBuffer();
      CliTerminalFormatter.renderStats(data);
    });
  }

  // Generate a unique instance ID for this CLI run
  const instanceId = crypto.randomUUID();

  // Lock management state
  let cliWorkingFilePath: string | undefined;
  let cliHeartbeatInterval: ReturnType<typeof setInterval> | undefined;

  const releaseLockAndCleanup = async (): Promise<void> => {
    if (cliHeartbeatInterval !== undefined) {
      clearInterval(cliHeartbeatInterval);
      cliHeartbeatInterval = undefined;
    }
    if (cliWorkingFilePath) {
      await WorkflowLockManager.releaseLock(cliWorkingFilePath).catch(() => {});
    }
  };

  // Handle Ctrl+C gracefully
  const cleanup = async (): Promise<void> => {
    if (!options.quiet) {
      console.log(chalk.yellow("\n\nInterrupted. Stopping workflow..."));
    }
    await instance.stop();
    await releaseLockAndCleanup();
    process.exit(5);
  };
  process.on("SIGINT", () => {
    void cleanup();
  });
  process.on("SIGTERM", () => {
    void cleanup();
  });
  // Best-effort lock release on any exit (covers process.exit() in non-signal paths)
  process.on("exit", () => {
    if (cliHeartbeatInterval !== undefined) {
      clearInterval(cliHeartbeatInterval);
    }
    // Synchronous file deletion is best-effort — failures are acceptable here
    if (cliWorkingFilePath) {
      try {
        const lockPath = WorkflowLockManager.getLockPath(cliWorkingFilePath);
        require("fs").unlinkSync(lockPath);
      } catch {
        // Ignore errors on exit
      }
    }
  });

  try {
    if (options.prompt) {
      instance.loadPromptString(options.prompt);
    } else {
      await instance.loadPromptFile(resolvedFile!);
    }

    // Merge CLI --var flags into the workflow's vars (CLI vars take highest precedence).
    // This must happen after loading so the workflow's own vars: defaults are already set.
    if (Object.keys(config.vars).length > 0) {
      const workflowFile = instance.promptQueue.getWorkflowFile();
      workflowFile.vars = { ...(workflowFile.vars ?? {}), ...config.vars };
    }

    // Acquire the process lock after loading so workingFilePath is available
    const queueStateAfterLoad = instance.promptQueue.getState();
    cliWorkingFilePath = queueStateAfterLoad.workingFilePath;
    if (cliWorkingFilePath) {
      const workflowId = path
        .basename(cliWorkingFilePath)
        .replace(/\.flightpath\.json$/, "");
      const lock: WorkflowRunnerLock = {
        runner: "cli",
        pid: process.pid,
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
        instanceId,
        workflowId,
      };
      await WorkflowLockManager.acquireLock(cliWorkingFilePath, lock).catch(
        (err) => {
          Log.warn(`[CLI] Failed to acquire lock: ${err}`);
        }
      );
      // Heartbeat every 5 seconds
      cliHeartbeatInterval = setInterval(() => {
        if (cliWorkingFilePath) {
          WorkflowLockManager.updateHeartbeat(cliWorkingFilePath).catch(
            () => {}
          );
        }
      }, 5_000);
    }

    // Apply --resume / --new-session overrides to the first prompt before execution.
    // getState() returns a shallow copy but prompts[] is the same array reference,
    // so mutations to PromptStep objects propagate into the queue's internal state.
    const queueState = instance.promptQueue.getState();
    if (config.sessionId && queueState.steps.length > 0) {
      const firstStep = queueState.steps[0];
      if (!isScriptStep(firstStep)) {
        firstStep.sessionId = config.sessionId;
        firstStep.resumeSession = true;
      }
    } else if (config.resumeSession === false) {
      for (const step of queueState.steps) {
        if (!isScriptStep(step)) {
          delete step.sessionId;
          step.resumeSession = false;
        }
      }
    } else if (config.resumeSession === true) {
      for (const step of queueState.steps) {
        if (!isScriptStep(step)) {
          step.resumeSession = true;
        }
      }
    }

    await instance.executeLoadedPromptFile(harness);

    const state = instance.promptQueue.getState();
    const exitCode = getExitCode(state);
    const completed = exitCode === 0;

    if (options.json) {
      const results = {
        version,
        file: resolvedFile,
        harness: config.harness,
        model: config.model,
        status: state.status,
        summary: {
          total: state.steps?.length ?? 0,
          completed:
            state.results?.filter((r) => r.status === STEP_STATUS.COMPLETED)
              .length ?? 0,
          failed:
            state.results?.filter((r) => r.status === STEP_STATUS.FAILED)
              .length ?? 0,
        },
      };
      console.log(JSON.stringify(results, null, 2));
    } else if (!options.quiet) {
      // In interactive mode the AI CLI TUI may leave the terminal with a hidden
      // cursor or stale attributes when killed. Reset before printing the summary.
      if (executionMode === EXECUTION_MODES.INTERACTIVE) {
        process.stdout.write("\x1b[?25h\x1b[0m\r\n");
      }
      console.log();
      console.log(chalk.dim("━".repeat(52)));
      if (completed) {
        console.log(chalk.green("✓ Workflow completed successfully"));
      } else {
        console.log(chalk.red("✗ Workflow ended: " + state.status));
      }
    }

    await releaseLockAndCleanup();
    process.exit(exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await releaseLockAndCleanup();
    if (options.json) {
      console.log(JSON.stringify({ status: "error", error: message }));
    } else {
      console.error(chalk.red("Error: " + message));
    }
    process.exit(2);
  }
}

async function validateCommand(file: string): Promise<void> {
  const resolvedFile = path.resolve(file);

  // Check file existence before invoking the parser to avoid internal Log.error() noise.
  try {
    await access(resolvedFile);
  } catch {
    console.error(chalk.red(`Error: File not found: ${resolvedFile}`));
    process.exit(2);
    return;
  }

  try {
    const { PromptFileParser } = await import("./flightpath/PromptFileParser");
    const parser = new PromptFileParser();
    const result = await parser.parsePromptFile(resolvedFile);
    if (result) {
      console.log(chalk.green(`✓ ${path.basename(resolvedFile)} is valid`));
      console.log(chalk.dim(`  ${result.steps?.length ?? 1} prompt(s)`));
      process.exit(0);
    } else {
      console.error(
        chalk.red(`✗ ${path.basename(resolvedFile)} failed validation`)
      );
      process.exit(2);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("Error: " + message));
    process.exit(2);
  }
}

interface CommitCommandOptions {
  model?: string;
  cwd?: string;
  hint?: string;
  printOnly?: boolean;
  yes?: boolean;
}

async function commitCommand(options: CommitCommandOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();

  Log.initializeCli(workingDir, false);

  const userBackend = createUserConfigBackend();
  const workspaceBackend = createWorkspaceConfigBackend(workingDir);
  configService.setUserBackend(userBackend);
  configService.setWorkspaceBackend(workspaceBackend);

  if (options.model) {
    const overlay: PartialFlightPathSettings = {
      commit: { model: options.model },
    };
    configService.setCliOverlay(overlay);
  }

  const { CommitMessageGenerator } =
    await import("./git/CommitMessageGenerator");
  const generator = new CommitMessageGenerator();

  console.error(chalk.dim("Checking for changes..."));
  const diffResult = await generator.getDiff(workingDir);
  if (!diffResult) {
    console.error("No changes detected. Stage or modify files first.");
    process.exit(0);
  }

  if (diffResult.truncated) {
    console.error(
      chalk.yellow(
        "Warning: Diff exceeded 8 KB and was truncated. Commit message may be incomplete."
      )
    );
  }

  console.error(chalk.dim("Generating commit message..."));
  let message: string;
  try {
    ({ message } = await generator.generateMessage(
      diffResult.diff,
      workingDir,
      undefined,
      options.hint
    ));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${errMsg}`));
    process.exit(1);
  }

  if (options.printOnly) {
    // Pipe-friendly: only the message goes to stdout.
    //   git commit -m "$(flightpath commit --print-only)"
    console.log(message);
    return;
  }

  console.error();
  console.error(chalk.bold("Generated commit message:"));
  console.error(chalk.dim("─".repeat(52)));
  console.error(message);
  console.error(chalk.dim("─".repeat(52)));
  console.error();

  if (!diffResult.staged) {
    console.error(
      chalk.yellow(
        "Note: Generated from unstaged changes. Stage files before committing."
      )
    );
    console.error();
  }

  if (!options.yes) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Commit with this message? [y/N] ", resolve);
    });
    rl.close();
    if (!answer.toLowerCase().startsWith("y")) {
      console.error("Aborted.");
      process.exit(0);
    }
  }

  const { GitCommitter } = await import("./git/GitCommitter");
  const committer = new GitCommitter();
  try {
    await committer.commit(message, workingDir);
    console.error(chalk.green("✓ Committed successfully"));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${errMsg}`));
    process.exit(1);
  }
}

/**
 * Determine a structured exit code from the final queue state.
 *
 * Exit codes:
 *   0 – success (all prompts completed)
 *   1 – prompt(s) failed (general AI / end-condition failure)
 *   3 – provider error (CLI not installed, auth failure, command not found)
 *   4 – timeout exceeded
 */
function getExitCode(state: QueueState): number {
  if (state.status === EXECUTION_STATES.COMPLETED) return 0;
  if (state.status === EXECUTION_STATES.ERROR) {
    // Scan failed results for a clue about the error category.
    const failedResult = state.results?.find(
      (r) => r.status === STEP_STATUS.FAILED && r.error
    );
    const errorMsg = (failedResult?.error ?? "").toLowerCase();
    if (
      errorMsg.includes("timeout") ||
      errorMsg.includes("timed out") ||
      errorMsg.includes("time limit")
    ) {
      return 4;
    }
    if (
      errorMsg.includes("not installed") ||
      errorMsg.includes("not found") ||
      errorMsg.includes("command not found") ||
      errorMsg.includes("enoent")
    ) {
      return 3;
    }
    return 1;
  }
  return 1;
}
