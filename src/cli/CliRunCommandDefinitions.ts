import { Command } from "commander";
import chalk from "chalk";
import {
  PERMISSION_MODES,
  isPermissionMode,
  type PermissionMode,
} from "../types/DashboardConstants";

export interface CliExecutionOptions {
  harness?: string;
  model?: string;
  cwd?: string;
  timeout?: number;
  scriptTimeout?: number;
  headless?: boolean;
  interactive?: boolean;
  allowTool: string[];
  denyTool: string[];
  permissionMode?: PermissionMode;
  var?: Record<string, string>;
  prompt?: string;
  sessionId?: string;
  resumeSession?: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

export interface RerunOptions extends CliExecutionOptions {
  workflow: string;
  from?: string;
}

export interface AppendOptions extends CliExecutionOptions {
  workflow: string;
  run: string;
  prompt?: string;
}

export interface ContinueOptions extends CliExecutionOptions {
  workflow: string;
  run: string;
}

export interface RunCommandOptions extends CliExecutionOptions {
  harness: string;
  var: Record<string, string>;
  dryRun?: boolean;
}

export interface RunScopedCommandHandlers {
  rerun(options: RerunOptions): Promise<void>;
  append(file: string | undefined, options: AppendOptions): Promise<void>;
  continue(options: ContinueOptions): Promise<void>;
}

/** Registers the primary `run` command; execution stays in `cli.ts`. */
export function registerRunCommand(
  program: Command,
  handler: (
    file: string | undefined,
    options: RunCommandOptions
  ) => Promise<void>
): void {
  addExecutionOptions(
    program
      .command("run [file]")
      .description(
        "Execute a prompt or workflow file (env passthrough works without a credential backend)"
      )
      .option(
        "-H, --harness <harness>",
        // No Commander default: an omitted flag must stay distinguishable from
        // an explicit one, so the workflow's own `harness` and the
        // `defaults.harness` setting are not silently overridden by copilot-cli.
        "AI harness: copilot-cli, claude-cli, codex-cli, antigravity-cli, qwen-cli, opencode-cli (default: the workflow's harness, then the defaults.harness setting)"
      )
      .option("-m, --model <model>", "Model to use")
      .option(
        "-p, --prompt <text>",
        "Inline prompt string (alternative to file)"
      )
      .option(
        "--session-id <id>",
        "Session ID to resume (implies --resume-session)"
      )
      .option("--resume-session", "Force resume of the existing session")
      .option(
        "--no-resume-session",
        "Force starting a new session, ignoring any existing session"
      )
      .option(
        "--var <assignment>",
        "Variable substitution: key=value (repeatable). Replaces {{key}} in prompt text, model, hooks, and endCondition.",
        collectVar,
        {} as Record<string, string>
      )
      .option(
        "--dry-run",
        "Show the redacted execution preview without starting a harness"
      )
  ).action(async (file: string | undefined, options: RunCommandOptions) =>
    handler(file, options)
  );
}

/** Registers only the run-scoped CLI surface; execution stays in `cli.ts`. */
export function registerRunScopedCommands(
  program: Command,
  handlers: RunScopedCommandHandlers
): void {
  addExecutionOptions(
    program
      .command("rerun")
      .description("Seed and execute a new run from an existing workflow run")
      .requiredOption("--workflow <key>", "Workflow lineage key")
      .option("--from <ref|runId>", "Source run reference or numeric run ID")
      .option(
        "-H, --harness <harness>",
        "Override harness for the newly seeded run"
      )
      .option("-m, --model <model>", "Override model for the newly seeded run")
  ).action(async (options: RerunOptions) => handlers.rerun(options));

  addExecutionOptions(
    program
      .command("append [file]")
      .description("Append steps to one run and continue it")
      .requiredOption("--workflow <key>", "Workflow lineage key")
      .requiredOption(
        "--run <ref|runId>",
        "Target run reference or numeric run ID"
      )
      .option(
        "-p, --prompt <text>",
        "Inline prompt string (alternative to file)"
      )
  ).action(async (file: string | undefined, options: AppendOptions) =>
    handlers.append(file, options)
  );

  addExecutionOptions(
    program
      .command("continue")
      .description("Continue unchanged pending work in one run")
      .requiredOption("--workflow <key>", "Workflow lineage key")
      .requiredOption(
        "--run <ref|runId>",
        "Target run reference or numeric run ID"
      )
  ).action(async (options: ContinueOptions) => handlers.continue(options));
}

function addExecutionOptions(command: Command): Command {
  return command
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option(
      "-t, --timeout <seconds>",
      "Override the execution.maxPromptTimeout setting for this run (-1 = unlimited)",
      parseTimeoutSeconds
    )
    .option(
      "--script-timeout <seconds>",
      "Override the execution.scriptTimeout setting for this run",
      parseTimeoutSeconds
    )
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
      `Override the defaults.toolPermissions.mode setting for this run: ${Object.values(PERMISSION_MODES).join(", ")}`,
      parsePermissionMode
    )

    .option("--json", "Output results as JSON")
    .option("-q, --quiet", "Suppress all output except errors")
    .option("--verbose", "Show debug information")
    .option("--no-color", "Disable colored output");
}

function parsePermissionMode(value: string): PermissionMode {
  if (!isPermissionMode(value)) {
    console.error(
      chalk.red(
        `Error: --permission-mode must be one of: ${Object.values(PERMISSION_MODES).join(", ")}`
      )
    );
    process.exit(2);
  }
  return value;
}

function parseTimeoutSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || (seconds < 1 && seconds !== -1)) {
    console.error(
      chalk.red(
        `Error: timeout "${value}" must be a whole number of seconds, or -1 for unlimited`
      )
    );
    process.exit(2);
  }
  return seconds;
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
