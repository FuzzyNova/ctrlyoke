import { Command, InvalidArgumentError } from "commander";
import {
  CLI_WORKFLOW_OPTION_DESCRIPTION,
  CLI_WORKFLOW_OPTION_FLAGS,
} from "./CliWorkflowOption";
import chalk from "chalk";
import {
  PERMISSION_MODES,
  SETTING_PATHS,
  isPermissionMode,
  type PermissionMode,
} from "../types/DashboardConstants";
import { getVariableKeyErrors } from "../utils/KeyValueKeyKinds";
import {
  FORCE_ALL_KEYWORD,
  ForceableFlag,
} from "./CliPropertyOverrides";

const WORKFLOW_PROPERTY_SCOPE_DESCRIPTION =
  " (workflow level; add `--force <flag>` to apply to every step)";

function workflowPropertyDescription(
  description: string,
  allowForce = false
): string {
  return (
    description +
    (allowForce
      ? WORKFLOW_PROPERTY_SCOPE_DESCRIPTION
      : " (workflow level; affects pending work)")
  );
}

export interface CliExecutionOptions {
  harness?: string;
  model?: string;
  cwd?: string;
  timeout?: number;
  scriptTimeout?: number;
  force?: string[];
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
        workflowPropertyDescription(
          "AI harness: copilot-cli, claude-cli, codex-cli, antigravity-cli, qwen-cli, opencode-cli (default: the workflow's harness, then the defaults.harness setting)",
          true
        )
      )
      .option(
        "-m, --model <model>",
        workflowPropertyDescription("Model to use", true)
      )
      .option(
        "--force <flags>",
        "Apply passed flags to every step: " +
          [...Object.values(ForceableFlag), FORCE_ALL_KEYWORD].join(", "),
        collectRepeatable,
        [] as string[]
      )
      .option(
        "-p, --prompt <text>",
        "Inline prompt string (alternative to file)"
      )
      .option(
        "--session-id <id>",
        workflowPropertyDescription(
          "Session ID to resume (implies --resume-session)",
          true
        )
      )
      .option(
        "--resume-session",
        workflowPropertyDescription("Resume the existing session", true)
      )
      .option(
        "--no-resume-session",
        workflowPropertyDescription(
          "Start a new session, ignoring any existing session",
          true
        )
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
      ),
    true
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
      .requiredOption(
        CLI_WORKFLOW_OPTION_FLAGS,
        CLI_WORKFLOW_OPTION_DESCRIPTION
      )
      .option("--from <ref|runId>", "Source run reference or numeric run ID")
      .option(
        "-H, --harness <harness>",
        workflowPropertyDescription("Override harness for the newly seeded run", true)
      )
      .option(
        "-m, --model <model>",
        workflowPropertyDescription("Override model for the newly seeded run", true)
      )
      .option(
        "--force <flags>",
        "Apply passed flags to every step: " +
          [...Object.values(ForceableFlag), FORCE_ALL_KEYWORD].join(", "),
        collectRepeatable,
        [] as string[]
      ),
    true
  ).action(async (options: RerunOptions) => handlers.rerun(options));

  addExecutionOptions(
    program
      .command("append [file]")
      .description("Append steps to one run and continue it")
      .requiredOption(
        CLI_WORKFLOW_OPTION_FLAGS,
        CLI_WORKFLOW_OPTION_DESCRIPTION
      )
      .requiredOption(
        "--run <ref|runId>",
        "Target run reference or numeric run ID"
      )
      .option("-H, --harness <harness>", "Override harness for appended steps")
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
      .requiredOption(
        CLI_WORKFLOW_OPTION_FLAGS,
        CLI_WORKFLOW_OPTION_DESCRIPTION
      )
      .requiredOption(
        "--run <ref|runId>",
        "Target run reference or numeric run ID"
      )
  ).action(async (options: ContinueOptions) => handlers.continue(options));
}

function addExecutionOptions(
  command: Command,
  allowForce = false
): Command {
  return command
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option(
      "-t, --timeout <seconds>",
      `Override the ${SETTING_PATHS.EXECUTION_MAX_PROMPT_TIMEOUT_SEC} setting for this run (-1 = unlimited)`,
      parseTimeoutSeconds
    )
    .option(
      "--script-timeout <seconds>",
      `Override the ${SETTING_PATHS.EXECUTION_SCRIPT_TIMEOUT_SEC} setting for this run`,
      parseScriptTimeoutSeconds
    )
    .option(
      "--headless",
      workflowPropertyDescription(
        "Force headless mode (CI/CD, no user interaction)",
        allowForce
      )
    )
    .option(
      "--interactive",
      workflowPropertyDescription(
        "Force interactive mode (TUI passthrough, user controls session end)",
        allowForce
      )
    )
    .option(
      "--allow-tool <pattern>",
      workflowPropertyDescription(
        "Allow specific tool pattern (repeatable)",
        allowForce
      ),
      collectRepeatable,
      [] as string[]
    )
    .option(
      "--deny-tool <pattern>",
      workflowPropertyDescription(
        "Deny specific tool pattern (repeatable)",
        allowForce
      ),
      collectRepeatable,
      [] as string[]
    )
    .option(
      "--permission-mode <mode>",
      workflowPropertyDescription(
        `Set the workflow tool permission mode for this run: ${Object.values(PERMISSION_MODES).join(", ")}`,
        allowForce
      ),
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

function parseScriptTimeoutSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new InvalidArgumentError(
      `script-timeout "${value}" must be a whole number of seconds greater than 0`
    );
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
  const assignment = value.slice(0, eqIndex);
  const next = { ...previous, [assignment]: value.slice(eqIndex + 1) };
  const errors = getVariableKeyErrors(Object.keys(next));
  if (errors.length > 0) {
    console.error(chalk.red(`Error: --var ${errors.join(", ")}`));
    process.exit(2);
  }
  return {
    ...next,
  };
}
