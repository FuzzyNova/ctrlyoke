import { ensureMinFsThreadpoolSize } from "./utils/ThreadPoolBootstrap";
ensureMinFsThreadpoolSize(64);

import { Command } from "commander";
import chalk from "chalk";
import * as path from "path";
import { access, readFile } from "fs/promises";

import { CliAdapter } from "./platform/CliAdapter";
import {
  applyCliPropertyOverrides,
  buildCliPropertyOverrides,
} from "./cli/CliPropertyOverrides";
import { ConsoleUserFeedbackSink } from "./platform/ConsoleUserFeedbackSink";
import type { ResolvedCliConfig } from "./platform/CliAdapter";
import { IntegrationFactory } from "./core/IntegrationFactory";
import { WorkflowInstance } from "./core/WorkflowInstance";
import {
  EXECUTION_STATES,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  RUNNER_IDS,
  WORKFLOW_LOCK_LIVENESS,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CLI_VALIDATE_TARGET_KINDS,
  CLI_VALIDATE_ERROR_CODES,
  getHarnessDisplayName,
  STATUS_MESSAGE_SEVERITY,
} from "./types/DashboardConstants";
import type {
  CliValidateStrictPolicy,
  HarnessId,
} from "./types/DashboardConstants";
import type {
  FinalStepRuntimeState,
  RunnerHostIdentity,
} from "./types/CtrlYokeTypes";
import { projectWorktreeRuntime } from "./types/CtrlYokeTypes";
import type { CompatibilityDiagnostic } from "./types/CompatibilityTypes";
import {
  isScriptStep,
  type PromptFile,
  type RunRef,
  type WorkflowKey,
  type WorkflowStep,
  type WorkingFile,
  type ParallelGroupDefinition,
  type WorkflowValidationWarning,
} from "./types/CtrlYokeTypes";
import { configService } from "./config/CtrlYokeConfigService";
import {
  createUserConfigBackend,
  createWorkspaceConfigBackend,
} from "./config/FileConfigBackend";
import type { PartialCtrlYokeSettings } from "./types/CtrlYokeSettings";
import type { QueueState } from "./types/CtrlYokeTypes";
import type { OutputExecutionTarget } from "./types/OutputHistoryTypes";
import { CliTerminalOutputGate } from "./cli/CliTerminalOutputGate";
import { inheritedTerminalOwnership } from "./utils/InheritedTerminalOwnership";
import { CliAttemptTally } from "./cli/CliAttemptTally";
import {
  CliTerminalFormatter,
  type CliOutputTarget,
} from "./cli/CliTerminalFormatter";
import {
  CLI_USAGE_EXIT_CODE,
  getExitCode as getTypedExitCode,
  handleCliError,
} from "./cli/CliExitCode";
import {
  buildCliJsonResult,
  buildCliPreviewJsonResult,
  buildCliValidationJsonResult,
  type CliValidationJsonHarness,
} from "./cli/CliJsonResultBuilder";
import { Log } from "./utils/Log";
import { getVariableKeyErrors } from "./utils/KeyValueKeyKinds";
import { setRuntimeMode } from "./utils/RuntimeMode";
import {
  ensureCtrlyokeShimsExecutable,
  getCtrlyokeBinDirectory,
  registerCtrlyokeBinDirectory,
  resolvePackageRootFromEntry,
} from "./utils/CtrlyokeCliPath";
import { aboutCommand } from "./cli/CliAboutCommand";
import {
  commitGeneratedChanges,
  generateCommitMessageForChanges,
} from "./cli/CommitCommand";
import { noteCliInstallation } from "./cli/CliInstallationNotice";
import {
  applyRunStateRefusal,
  trackRunStateRefusals,
} from "./cli/CliSchemaRefusal";
import { ConfigurationUtils } from "./utils/ConfigurationUtils";
import {
  ExternalRootsTrustStore,
  externalRootsTrustStore,
} from "./config/ExternalRootsTrustStore";
import { secretGrantsTrustStore } from "./config/SecretGrantsTrustStore";
import { WorkingFileManager } from "./core/WorkingFileManager";
import {
  RUN_CONTINUATION_ACTIONS,
  RunContinuationService,
} from "./core/orchestration/RunContinuationService";
import { WorkflowLineageRepository } from "./core/orchestration/WorkflowLineageRepository";
import { OutputHistoryManager } from "./core/orchestration/OutputHistoryManager";
import { createPriorContextResolver } from "./core/orchestration/AddressedPriorContextResolver";
import {
  getAuthoredSourcePath,
  PromptFileParser,
} from "./core/PromptFileParser";
import { readWorkflowLockInspection } from "./utils/WorkflowLockInspector";
import * as WorkflowPaths from "./utils/WorkflowPaths";
import {
  resolveCliRunRefAtLineage,
  resolveCliWorkflowKey,
} from "./cli/CliRunSelector";
import { resolveCliFileArgument } from "./cli/CliFileArgument";
import {
  applyCliAppendOverrides,
  parseCliPromptFile,
} from "./cli/CliPromptFile";
import {
  registerRunCommand,
  registerRunScopedCommands,
  type AppendOptions,
  type ContinueOptions,
  type RerunOptions,
  type RunCommandOptions,
} from "./cli/CliRunCommandDefinitions";
import { registerHistoryCommands } from "./cli/HistoryCommandDefinitions";
import { registerStatusCommand } from "./cli/StatusCommandDefinitions";
import { registerServerCommand } from "./cli/ServerCommand";
import { statusCommand } from "./cli/CliStatusCommand";
import {
  CLI_CLOSED_PIPE_EXIT_CODE,
  exitQuietlyOnClosedPipe,
  isClosedPipeError,
} from "./cli/CliClosedPipe";
import { registerStepCommands } from "./cli/StepCommandDefinitions";
import { registerSecretCommands } from "./cli/SecretCommandDefinitions";
import {
  pruneHistoryCommand,
  relinkHistoryCommand,
  type HistoryCommandIo,
} from "./cli/HistoryCommands";
import {
  emptyTrashCommand,
  listTrashCommand,
  purgeTrashCommand,
  restoreTrashCommand,
} from "./cli/HistoryTrashCommands";
import {
  listHistoryCommand,
  runsHistoryCommand,
  searchHistoryCommand,
  stepsHistoryCommand,
  showHistoryCommand,
  type HistoryInspectionCommandIo,
} from "./cli/HistoryInspectionCommands";
import {
  createStepCommandContext,
  editStepCommand,
  removeStepCommand,
  reorderStepsCommand,
} from "./cli/StepCommands";
import type {
  StepEditOptions,
  StepRemoveOptions,
  StepReorderOptions,
} from "./cli/StepCommandDefinitions";
import {
  checkSecretsCommand,
  createCliSecretCommandDependencies,
  createSecretCommandIo,
  listSecretsCommand,
  removeSecretCommand,
  setSecretCommand,
  trustSecretGrantsCommand,
} from "./cli/SecretCommands";
import {
  findUnapprovedStepSecretGrants,
  formatAppendedUnapprovedSecretGrantsWarning,
  getWorkflowSecretGrants,
} from "./utils/SecretResolver";
import { resolveCliExecutionMode } from "./cli/CliExecutionMode";
import { promptYesNo } from "./cli/CliPrompt";
import {
  TRUST_WORKSPACE_SETTINGS_COMMAND,
  createWorkspaceSettingsTrustIo,
  ensureWorkspaceSettingsDecided,
  trustWorkspaceSettingsCommand,
  type TrustWorkspaceSettingsOptions,
} from "./cli/WorkspaceSettingsTrustCommands";
import { bootstrapCliWorkspace } from "./cli/CliWorkspaceBootstrap";
import { ExecutionPreviewService } from "./core/ExecutionPreviewService";
import { HarnessCapabilityRegistry } from "./core/HarnessCapabilityRegistry";
import type { HarnessCapabilitySource } from "./core/HarnessCapabilityRegistry";
import { PropertyResolver } from "./utils/PropertyResolver";
import type { WorkflowExecutionPreview } from "./types/ExecutionPreviewTypes";
import { repoToplevel } from "./utils/GitUtils";
import {
  ProjectStateRegistry,
  getStateHomeWarning,
} from "./utils/ProjectStateRegistry";
import { ctrlyokeStateHome } from "./utils/ProjectStatePaths";
import { initializeRunHistoryLocation } from "./utils/RunHistoryStoragePolicy";
import { secretRedactionService } from "./utils/SecretRedactionService";
import {
  analyzeCliCompatibility,
  assertCliValidateHarnessId as assertHarnessId,
  hasCliValidationFailures,
  parseCliValidateStrictPolicy,
  selectCliValidationHarnesses,
  type CliValidationTarget,
} from "./cli/CliValidation";
import { formatFinalPassLabel } from "./utils/FinalStepLabels";

// Mark this process as the standalone CLI binary before anything else runs.
setRuntimeMode(RUNNER_IDS.CLI);
// Harnesses this CLI spawns resolve `ctrlyoke` to this same install. A tarball
// packed on Windows carries no executable bit, so restore it like the extension does.
registerCtrlyokeBinDirectory(resolvePackageRootFromEntry(__filename));

// A newer ctrlyoke's run state refused mid-run surfaces as a failed step; this
// lets the run exit 2 ("update ctrlyoke") instead of 1 (CLI_DISTRIBUTION_PLAN §3.4).
const runStateRefusals = trackRunStateRefusals();
const cliBinDirectory = getCtrlyokeBinDirectory();
if (cliBinDirectory) {
  ensureCtrlyokeShimsExecutable(cliBinDirectory);
}

/** Determine a structured exit code from the final queue state. */
function getExitCode(
  state: QueueState,
  finalStepRuntime?: FinalStepRuntimeState
): number {
  return getTypedExitCode(state, finalStepRuntime);
}

const cliRunnerHostIdentity: RunnerHostIdentity = {
  runner: RUNNER_IDS.CLI,
  hostInstanceId: crypto.randomUUID(),
  pid: process.pid,
};

// VERSION is injected by esbuild define
declare const VERSION: string;
const version = typeof VERSION !== "undefined" ? VERSION : "0.0.0-dev";

const program = new Command();
program.exitOverride((error) => {
  process.exit(error.exitCode === 0 ? 0 : CLI_USAGE_EXIT_CODE);
});

const CLI_RUN_OPERATION_KINDS = {
  RUN: "run",
  RERUN: "rerun",
  APPEND: "append",
  CONTINUE: "continue",
} as const;

program
  .name("ctrlyoke")
  .description(
    "Execute AI-powered workflow automation from the command line. `run` works with env passthrough even when no credential backend is available."
  )
  .version(version);

// Tell the user once when a newer VS Code extension shares this machine's
// state (dev/backlog/CLI_DISTRIBUTION_PLAN.md §3.4 rule 2).
program.hook("preAction", () =>
  noteCliInstallation(
    version,
    resolvePackageRootFromEntry(__filename),
    (message) => console.error(chalk.yellow(message))
  )
);

registerRunCommand(program, runCommand);
registerServerCommand(program);

registerRunScopedCommands(program, {
  rerun: rerunCommand,
  append: appendCommand,
  continue: continueCommand,
});

registerHistoryCommands(program, {
  prune: (options) =>
    handleHistoryCommand(
      pruneHistoryCommand(options, {
        writeOut: (message) => console.log(message),
        writeErr: (message) => console.error(chalk.yellow(message)),
        isInteractive: !!process.stdin.isTTY && !!process.stdout.isTTY,
        confirm: promptYesNo,
      })
    ),
  relink: (oldPath, newPath, options) =>
    handleHistoryCommand(
      relinkHistoryCommand(oldPath, newPath, options, {
        writeOut: (message) => console.log(message),
        writeErr: (message) => console.error(chalk.yellow(message)),
        isInteractive: !!process.stdin.isTTY && !!process.stdout.isTTY,
        confirm: promptYesNo,
      })
    ),
  list: (options) =>
    handleHistoryCommand(
      listHistoryCommand(options, createHistoryInspectionCommandIo())
    ),
  runs: (options) =>
    handleHistoryCommand(
      runsHistoryCommand(options, createHistoryInspectionCommandIo())
    ),
  show: (options) =>
    handleHistoryCommand(
      showHistoryCommand(options, createHistoryInspectionCommandIo())
    ),
  steps: (options) =>
    handleHistoryCommand(
      stepsHistoryCommand(options, createHistoryInspectionCommandIo())
    ),
  search: (query, options) =>
    handleHistoryCommand(
      searchHistoryCommand(query, options, createHistoryInspectionCommandIo())
    ),
  trash: {
    list: (options) =>
      handleHistoryCommand(
        listTrashCommand(options, createHistoryInspectionCommandIo())
      ),
    restore: (entryId, options) =>
      handleHistoryCommand(
        restoreTrashCommand(
          entryId,
          options,
          createHistoryInspectionCommandIo()
        )
      ),
    purge: (entryId, options) =>
      handleHistoryCommand(
        purgeTrashCommand(entryId, options, createHistoryCommandIo())
      ),
    empty: (options) =>
      handleHistoryCommand(
        emptyTrashCommand(options, createHistoryCommandIo())
      ),
  },
});

registerStatusCommand(program, {
  status: (options) =>
    handleHistoryCommand(
      statusCommand(options, {
        writeOut: (message) => console.log(message),
        writeErr: (message) => console.error(message),
      })
    ),
});

registerStepCommands(program, {
  edit: (file, options) =>
    handleStepCommand(
      prepareStepCommand(options).then((context) =>
        editStepCommand(file, options, context, {
          writeOut: (message) => console.log(message),
          writeErr: (message) => console.error(message),
        })
      ),
      options.json === true
    ),
  remove: (options) =>
    handleStepCommand(
      prepareStepCommand(options).then((context) =>
        removeStepCommand(options, context, {
          writeOut: (message) => console.log(message),
          writeErr: (message) => console.error(message),
        })
      ),
      options.json === true
    ),
  reorder: (options) =>
    handleStepCommand(
      prepareStepCommand(options).then((context) =>
        reorderStepsCommand(options, context, {
          writeOut: (message) => console.log(message),
          writeErr: (message) => console.error(message),
        })
      ),
      options.json === true
    ),
});

registerSecretCommands(program, {
  set: (name, options) =>
    handleSecretCommand(
      setSecretCommand(
        name,
        options,
        createCliSecretCommandDependencies(
          path.resolve(options.cwd ?? process.cwd())
        ),
        createSecretCommandIo()
      )
    ),
  list: (options) =>
    handleSecretCommand(
      listSecretsCommand(
        options,
        createCliSecretCommandDependencies(
          path.resolve(options.cwd ?? process.cwd())
        ),
        createSecretCommandIo()
      )
    ),
  remove: (name, options) =>
    handleSecretCommand(
      removeSecretCommand(
        name,
        options,
        createCliSecretCommandDependencies(
          path.resolve(options.cwd ?? process.cwd())
        ),
        createSecretCommandIo()
      )
    ),
  check: (file, options) =>
    handleSecretCommand(
      (async () => {
        Log.initializeCli(path.resolve(options.cwd ?? process.cwd()), false);
        return checkSecretsCommand(
          file,
          options,
          createCliSecretCommandDependencies(
            path.resolve(options.cwd ?? process.cwd())
          ),
          createSecretCommandIo()
        );
      })()
    ),
  trustSecretGrants: (file, options) =>
    handleSecretCommand(
      (async () => {
        Log.initializeCli(path.resolve(options.cwd ?? process.cwd()), false);
        return trustSecretGrantsCommand(
          file,
          options,
          createCliSecretCommandDependencies(
            path.resolve(options.cwd ?? process.cwd())
          ),
          createSecretCommandIo()
        );
      })()
    ),
});

program
  .command("validate <file>")
  .description("Validate a prompt file without executing it")
  .option(
    "-H, --harness <harness>",
    "Analyze every AI consumer as this harness"
  )
  .option(
    "--all-installed-harnesses",
    "Analyze every AI consumer on each installed harness"
  )
  .option(
    "--strict [policy]",
    "Treat unknown workflow fields as errors; with a policy, also fail on compatibility warnings"
  )
  .option("--json", "Emit one versioned JSON result line")
  .action(async (file: string, options: ValidateCommandOptions) => {
    await validateCommand(file, options);
  });

program
  .command("about")
  .description(
    "Show this CLI's version, where it is installed, and other ctrlyoke installations on this machine"
  )
  .option("--json", "Emit one versioned JSON result line")
  .action(async (options: { json?: boolean }) => {
    await aboutCommand(
      version,
      resolvePackageRootFromEntry(__filename),
      options,
      (message) => console.log(message)
    );
  });

program
  .command("trust-external-roots")
  .description(
    "Review and approve this workspace's requested external file roots (permissions.trustedExternalRoots)"
  )
  .option("-d, --cwd <path>", "Working directory (default: current directory)")
  .option("-y, --yes", "Approve all pending roots without prompting")
  .action(async (options: TrustExternalRootsOptions) => {
    await trustExternalRootsCommand(options);
  });

program
  .command("trust-workflow-external-roots <file>")
  .description("Review and approve a workflow's requested trustedExternalRoots")
  .option("-d, --cwd <path>", "Working directory (default: current directory)")
  .option("-y, --yes", "Approve all pending roots without prompting")
  .action(async (file: string, options: TrustWorkflowExternalRootsOptions) => {
    await trustWorkflowExternalRootsCommand(file, options);
  });

program
  .command(TRUST_WORKSPACE_SETTINGS_COMMAND)
  .description(
    "Review this workspace's settings that choose a program to run (shell, hooks, MCP servers, harness flags, default scripts)"
  )
  .option("-d, --cwd <path>", "Working directory (default: current directory)")
  .option("-y, --yes", "Allow every listed value without prompting")
  .option("--all", "Also list values already allowed or denied")
  .action(async (options: TrustWorkspaceSettingsOptions) => {
    const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
    Log.initializeCli(workingDir, false);
    configService.setUserBackend(createUserConfigBackend());
    configService.setWorkspaceBackend(createWorkspaceConfigBackend(workingDir));
    process.exit(
      await trustWorkspaceSettingsCommand(
        workingDir,
        options,
        createWorkspaceSettingsTrustIo()
      )
    );
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
  .option(
    "--all",
    "Stage all changes before committing (including unstaged and untracked files)"
  )
  .option("-y, --yes", "Skip confirmation prompt and commit automatically")
  .action(async (options: CommitCommandOptions) => {
    await commitCommand(options);
  });

void program.parseAsync().catch((error: unknown) => {
  handleCliError(error, (message) => console.error(chalk.red(message)));
});

// ---- Types ----

type RunOptions = RunCommandOptions;

interface CliParallelGroupState {
  group: ParallelGroupDefinition;
  memberCount: number;
  started: Set<number>;
  completed: Set<number>;
  failed: Set<number>;
}

/**
 * The workflow-level harness and model a run reports in its header and
 * `--json` result, using the precedence execution applies: an explicit
 * `--harness`/`--model` flag, then the workflow's own `harness`/`model`, then
 * the settings defaults. Individual steps may still name their own harness.
 */
function resolveCliRunHarnessAndModel(
  workflow: PromptFile | undefined,
  defaultHarness: HarnessId
): { harness: HarnessId; model?: string } {
  const harness = workflow?.harness ?? defaultHarness;
  const model =
    workflow?.model ?? ConfigurationUtils.getModelForHarness(harness);
  return { harness, ...(model ? { model } : {}) };
}

function getCliReportingWorkflow(
  workflow: PromptFile | undefined,
  operation: CliRunOperation,
  options: RunCommandOptions | RerunOptions | AppendOptions | ContinueOptions
): PromptFile | undefined {
  if (operation.kind === CLI_RUN_OPERATION_KINDS.RUN || !workflow) {
    return workflow;
  }

  // Rerun's harness/model flags are workflow-scoped. Append's harness flag
  // remains specific to the appended steps.
  return {
    ...workflow,
    ...(operation.kind === CLI_RUN_OPERATION_KINDS.RERUN && options.harness
      ? { harness: options.harness as HarnessId }
      : {}),
    ...(operation.kind === CLI_RUN_OPERATION_KINDS.RERUN && options.model
      ? { model: options.model }
      : {}),
  };
}

function getCliPromptExecutionDetails(
  instance: WorkflowInstance,
  stepIndex: number,
  defaults: { harness: HarnessId; model?: string }
): { harness?: HarnessId; model?: string } {
  const workflow = instance.promptQueue.getWorkflowFile();
  const step = instance.promptQueue.getState().steps[stepIndex];
  const promptStep = step && !isScriptStep(step) ? step : undefined;
  return {
    harness:
      step?._runtime?.harness ??
      promptStep?.harness ??
      workflow.harness ??
      defaults.harness,
    model:
      step?._runtime?.model ??
      promptStep?.model ??
      workflow.model ??
      defaults.model,
  };
}

function getCliOutputStepName(
  instance: WorkflowInstance,
  target: OutputExecutionTarget
): string {
  const workflow = instance.promptQueue.getWorkflowFile();
  const step =
    target.kind === FINAL_STEP_PHASES.QUEUE
      ? instance.promptQueue.getState().steps[target.stepIndex]
      : workflow.finalStep;
  if (step?.name?.trim()) return step.name.trim();
  if (step && isScriptStep(step))
    return step.script.split(/\s+/)[0] ?? "script";
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? `Step ${target.stepIndex + 1}`
    : formatFinalPassLabel(target.loopIndex + 1);
}

/** The terminal output target for an execution target's attempt. */
function toCliOutputTarget(
  target: OutputExecutionTarget,
  stepName: string
): CliOutputTarget & { key: string } {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? {
        stepIndex: target.stepIndex,
        stepName,
        key: `queue:${target.stepIndex}`,
      }
    : {
        stepIndex: target.loopIndex,
        stepName,
        key: `final:${target.loopIndex}`,
      };
}

interface ValidateCommandOptions {
  harness?: string;
  allInstalledHarnesses?: boolean;
  strict?: string | boolean;
  json?: boolean;
}

type CliRunOperation =
  | { kind: typeof CLI_RUN_OPERATION_KINDS.RUN }
  | {
      kind: typeof CLI_RUN_OPERATION_KINDS.RERUN;
      workflow: string;
      from?: string;
    }
  | {
      kind: typeof CLI_RUN_OPERATION_KINDS.APPEND;
      workflow: string;
      run: string;
      file?: string;
    }
  | {
      kind: typeof CLI_RUN_OPERATION_KINDS.CONTINUE;
      workflow: string;
      run: string;
    };

/**
 * Report workflow steps whose interactive request will be clamped because the
 * CLI host cannot provide a PTY. PropertyResolver performs the actual clamp;
 * this is only the user-facing aggregate diagnostic.
 */
function warnAboutClampedInteractiveSteps(
  workflow: PromptFile,
  hostCanProvidePty: boolean
): void {
  if (hostCanProvidePty) {
    return;
  }

  // Mirror PropertyResolver's three-tier precedence without its clamp, which is
  // already active by the time this diagnostic runs and would report nothing.
  const settingsMode = ConfigurationUtils.getCliExecutionMode();
  const downgradedSteps = (workflow.steps ?? [])
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        (step.executionMode ?? workflow.executionMode ?? settingsMode) ===
        EXECUTION_MODES.INTERACTIVE
    )
    .map(({ step, index }) => step.name?.trim() || `step ${index + 1}`);

  if (downgradedSteps.length === 0) {
    return;
  }

  Log.warn(
    `[Cli] CLI cannot provide an interactive PTY; downgraded step(s) to headless: ${downgradedSteps.join(", ")}`
  );
}

// ---- Commands ----

async function rerunCommand(options: RerunOptions): Promise<void> {
  await runCommand(undefined, options, {
    kind: CLI_RUN_OPERATION_KINDS.RERUN,
    workflow: options.workflow,
    from: options.from,
  });
}

async function appendCommand(
  file: string | undefined,
  options: AppendOptions
): Promise<void> {
  await runCommand(file, options, {
    kind: CLI_RUN_OPERATION_KINDS.APPEND,
    workflow: options.workflow,
    run: options.run,
    file,
  });
}

async function continueCommand(options: ContinueOptions): Promise<void> {
  await runCommand(undefined, options, {
    kind: CLI_RUN_OPERATION_KINDS.CONTINUE,
    workflow: options.workflow,
    run: options.run,
  });
}

async function runCommand(
  file: string | undefined,
  options: RunOptions | RerunOptions | AppendOptions | ContinueOptions,
  operation: CliRunOperation = { kind: CLI_RUN_OPERATION_KINDS.RUN }
): Promise<void> {
  if (
    operation.kind === CLI_RUN_OPERATION_KINDS.RUN &&
    options.sessionId !== undefined &&
    options.resumeSession === false
  ) {
    console.error(
      chalk.red("Error: --session-id cannot be used with --no-resume-session")
    );
    process.exit(2);
  }
  if (options.harness !== undefined) {
    try {
      assertHarnessId(options.harness);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Error: ${message}`));
      process.exit(2);
    }
  }

  CliTerminalFormatter.setColorEnabled(options.color !== false);

  if (
    (operation.kind === CLI_RUN_OPERATION_KINDS.RUN ||
      operation.kind === CLI_RUN_OPERATION_KINDS.APPEND) &&
    !file &&
    !options.prompt
  ) {
    console.error(
      chalk.red("Error: Provide a file argument or --prompt <text>")
    );
    process.exit(2);
  }
  if (
    (operation.kind === CLI_RUN_OPERATION_KINDS.RUN ||
      operation.kind === CLI_RUN_OPERATION_KINDS.APPEND) &&
    file &&
    options.prompt
  ) {
    console.error(
      chalk.red("Error: --prompt cannot be used together with a file argument")
    );
    process.exit(2);
  }

  const resolvedFile = file ? resolveCliFileArgument(file) : undefined;
  const workingDir = options.cwd ?? process.cwd();

  // Redirect all Log.* output to .ctrlyoke/logs/ctrlyoke-<timestamp>.log.
  // Must be called before any component code that calls Log.debug/info/etc.,
  // so that diagnostic messages never pollute the terminal output.
  Log.initializeCli(workingDir, options.verbose);

  // Host capability is physical (TTYs); execution-mode flags are workflow overrides.
  const {
    executionMode,
    hostCanProvidePty,
    supportsConcurrentInteractiveSessions,
  } = resolveCliExecutionMode(!!process.stdout.isTTY, !!process.stdin.isTTY);

  const config: ResolvedCliConfig = {
    model: options.model,
    cwd: workingDir,
    vars: options.var || {},
    verbose: options.verbose ?? false,
    quiet: options.quiet ?? false,
    json: options.json ?? false,
    cliExecutionMode: executionMode,
  };

  // Initialize config service with file-based backends so that settings from
  // ~/.ctrlyoke/settings.json and <workspace>/.ctrlyoke/settings.json are
  // resolved before applying the CLI overlay below.
  const userBackend = createUserConfigBackend();
  const workspaceBackend = createWorkspaceConfigBackend(workingDir);
  configService.setUserBackend(userBackend);
  configService.setWorkspaceBackend(workspaceBackend);

  // Build CLI overlay from explicitly provided flags only (not Commander defaults).
  const overlay: PartialCtrlYokeSettings = {};
  // Keep the TTY-derived mode at settings tier as the default. Explicit mode
  // flags are applied to the workflow after it has loaded.
  overlay.defaults = { ...overlay.defaults, executionMode };
  if (options.timeout !== undefined || options.scriptTimeout !== undefined) {
    overlay.execution = {
      ...(options.timeout !== undefined && {
        maxPromptTimeoutSec: options.timeout,
      }),
      ...(options.scriptTimeout !== undefined && {
        scriptTimeoutSec: options.scriptTimeout,
      }),
    };
  }
  configService.setCliOverlay(overlay);

  // Run history is a startup-frozen resource. Initialize it only for the
  // execution/continuation command family; validate and commit have separate
  // lightweight bootstraps and must not create project state.
  const runHistoryLocation = configService.get("storage").runHistoryLocation;
  initializeRunHistoryLocation(runHistoryLocation);
  const gitToplevel = await repoToplevel(workingDir);
  const stateHomeWarning = getStateHomeWarning(
    ctrlyokeStateHome(),
    [workingDir],
    gitToplevel ? [gitToplevel] : []
  );
  if (stateHomeWarning) {
    Log.warn(`[Cli] ctrlyoke: ${stateHomeWarning}`);
  }
  await new ProjectStateRegistry().initialize(
    workingDir,
    gitToplevel ?? undefined
  );

  // Fail closed when this workspace requests external file roots
  // (permissions.trustedExternalRoots at workspace scope) that have not
  // been reviewed yet — see dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
  // User-scope roots need no such gate (the user already approved them by
  // editing their own settings).
  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workingDir);
  const pendingExternalRoots =
    ConfigurationUtils.getPendingWorkspaceExternalFileRoots(workspaceIdentity);
  if (pendingExternalRoots.length > 0) {
    console.error(
      chalk.red(
        "Error: This workspace requests external file roots that have not been approved yet:"
      )
    );
    pendingExternalRoots.forEach((root) =>
      console.error(chalk.red(`  - ${root}`))
    );
    console.error(
      chalk.yellow(
        "Run `ctrlyoke trust-external-roots` to review and approve them."
      )
    );
    process.exit(2);
  }

  // Workspace settings that choose a program to run (shell, hooks, MCP
  // servers, harness flags, default scripts) need a decision before the
  // workflow loads, because loading copies settings defaults into the run.
  const workspaceSettingsExitCode = await ensureWorkspaceSettingsDecided(
    workingDir,
    createWorkspaceSettingsTrustIo()
  );
  if (workspaceSettingsExitCode !== undefined) {
    process.exit(workspaceSettingsExitCode);
  }

  const platform = new CliAdapter(config);
  const userFeedbackSink = new ConsoleUserFeedbackSink();
  const factory = new IntegrationFactory(platform, userFeedbackSink);
  // The default harness used only when neither a step nor the workflow names
  // one. `run --harness` is applied to the workflow after it loads, so the
  // default needs no detection then.
  if (!options.harness) {
    await IntegrationFactory.detectDefaultHarness();
  }
  const harness = ConfigurationUtils.getIntegrationMode();

  if (
    operation.kind === CLI_RUN_OPERATION_KINDS.RUN &&
    isRunCommandOptions(options) &&
    options.dryRun
  ) {
    await dryRunCommand(
      resolvedFile,
      options,
      config,
      harness,
      workingDir,
      hostCanProvidePty,
      supportsConcurrentInteractiveSessions,
      platform,
      factory,
      userFeedbackSink
    );
    return;
  }

  if (options.verbose && !options.json) {
    console.log(
      chalk.dim(
        `[verbose] Execution mode: ${executionMode} (TTY: stdout=${!!process.stdout.isTTY} stdin=${!!process.stdin.isTTY})`
      )
    );
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

  // Printed once the workflow is loaded, because the harness and model it
  // names come from the workflow file itself, not only from CLI flags.
  let runHeaderPrinted = false;
  const printRunHeader = (): void => {
    if (runHeaderPrinted) {
      return;
    }
    runHeaderPrinted = true;
    const { harness: runHarness, model: runModel } =
      resolveCliRunHarnessAndModel(
        getCliReportingWorkflow(
          instance.promptQueue.getWorkflowFile(),
          operation,
          options
        ),
        harness
      );
    if (options.verbose && !options.json) {
      console.log(chalk.dim(`[verbose] Harness: ${runHarness}`));
      if (runModel) {
        console.log(chalk.dim(`[verbose] Model: ${runModel}`));
      }
    }
    if (options.quiet || options.json) {
      return;
    }
    if (executionMode === EXECUTION_MODES.INTERACTIVE) {
      // ctrlyoke header minimal so it doesn't clutter the user's session.
      console.log(
        chalk.dim(
          `ctrlyoke v${version} — starting ${chalk.yellow(runHarness)} in interactive mode…`
        )
      );
      console.log();
    } else {
      console.log(chalk.bold(`ctrlyoke CLI v${version}`));
      console.log(chalk.dim("━".repeat(52)));
      console.log();
      console.log(
        `Running: ${chalk.cyan(resolvedFile ? path.basename(resolvedFile) : "<inline prompt>")}`
      );
      console.log(
        `Harness: ${chalk.yellow(runHarness)}${runModel ? chalk.dim(" (" + runModel + ")") : ""}`
      );
      console.log(chalk.dim("─".repeat(52)));
    }
  };

  // Create a cached detector integration (pre-marked as ready, used for pre-flight checks)
  const detectorIntegration = factory.createForExecution(harness);

  const instance = new WorkflowInstance(
    platform,
    undefined, // no dashboard sink in CLI
    factory,
    (_harnessOverride?: HarnessId) => detectorIntegration,
    (_name: string | undefined) => {}, // no tab management
    () => {}, // no status bar update
    workingDir,
    hostCanProvidePty,
    supportsConcurrentInteractiveSessions,
    undefined,
    userFeedbackSink,
    undefined,
    undefined,
    undefined,
    cliRunnerHostIdentity,
    undefined,
    options.sessionId !== undefined
  );

  // Stream output to the terminal as events arrive. Subscriptions go on the
  // instance (not detectorIntegration) because WorkflowInstance creates a fresh
  // execution integration via the factory and forwards events from it.
  // The run-level mode does not decide this: an interactive run still has
  // headless steps (a step's own `executionMode` wins), scripts, statuses and
  // verdicts. Only an interactive attempt's harness output is left out, since
  // its TUI already shows it, and anything rendered while a TUI owns the
  // terminal waits for that TUI to exit.
  let releaseLiveOutputState = (): void => {};
  if (!options.quiet && !options.json) {
    const outputGate = new CliTerminalOutputGate(
      inheritedTerminalOwnership,
      (deferredCount) =>
        CliTerminalFormatter.renderTerminalReturned(deferredCount)
    );
    // The script reporter emits a rich verdict and also sends the historical
    // one-line status message. Collapse the latter when its matching verdict
    // has already reached this terminal, while preserving unrelated statuses.
    const pendingScriptStatusMessages = new Map<string, number>();
    const parallelGroups = new Map<string, CliParallelGroupState>();
    const attempts = new CliAttemptTally();
    const renderedFinalStepLabels = new Set<number>();
    let released = false;

    const renderFinalStepLabel = (target: OutputExecutionTarget): void => {
      if (
        target.kind !== FINAL_STEP_PHASES.FINAL_STEP ||
        renderedFinalStepLabels.has(target.loopIndex)
      ) {
        return;
      }
      renderedFinalStepLabels.add(target.loopIndex);
      CliTerminalFormatter.renderFinalStepLabel(target.loopIndex);
    };

    const renderPromptHeader = (
      data: Parameters<typeof CliTerminalFormatter.renderPromptHeader>[0]
    ): void => {
      CliTerminalFormatter.renderPromptHeader({
        ...data,
        ...getCliPromptExecutionDetails(instance, data.stepIndex, {
          harness,
          model: config.model,
        }),
      });
    };

    const getParallelGroup = (
      parallelGroupId: string | undefined
    ): CliParallelGroupState | undefined => {
      if (!parallelGroupId) {
        return undefined;
      }
      const group = instance.promptQueue
        .getState()
        .parallelGroups.find((candidate) => candidate.id === parallelGroupId);
      if (!group) {
        return undefined;
      }
      let state = parallelGroups.get(group.id);
      if (!state) {
        state = {
          group,
          memberCount: group.endIndex - group.startIndex + 1,
          started: new Set<number>(),
          completed: new Set<number>(),
          failed: new Set<number>(),
        };
        parallelGroups.set(group.id, state);
      }
      return state;
    };

    const renderParallelGroupProgress = (
      state: CliParallelGroupState
    ): void => {
      const running = Math.max(
        0,
        state.started.size - state.completed.size - state.failed.size
      );
      CliTerminalFormatter.renderParallelGroupProgress(
        state.group.id,
        running,
        state.completed.size,
        state.failed.size
      );
    };

    releaseLiveOutputState = (): void => {
      if (released) {
        return;
      }
      released = true;
      outputGate.write(() => {
        for (const attempt of attempts.retriedGroups()) {
          CliTerminalFormatter.renderAttemptGroupSummary(
            attempt.stepName,
            attempt.attemptCount,
            attempt.totalElapsed,
            attempt.tokenStats
          );
        }
        attempts.clear();
        parallelGroups.clear();
        renderedFinalStepLabels.clear();
        pendingScriptStatusMessages.clear();
        CliTerminalFormatter.disposeEventStreams();
      });
    };

    // Every attempt, queue step or finalStep pass, streams into a fresh
    // stream; the stream outlives completion so follow-up activity pairs.
    // Retry tallies cover every target, keyed like its output stream.
    instance.onTargetAttemptStart(({ target, attemptIndex }) =>
      outputGate.write(() => {
        const outputTarget = toCliOutputTarget(
          target,
          getCliOutputStepName(instance, target)
        );
        CliTerminalFormatter.replaceEventStream(outputTarget);
        attempts.start(outputTarget.key, outputTarget.stepName, attemptIndex);
      })
    );
    instance.onTargetAttemptComplete(({ target, stats }) =>
      outputGate.write(() => {
        const outputTarget = toCliOutputTarget(
          target,
          getCliOutputStepName(instance, target)
        );
        attempts.complete(outputTarget.key, stats);
        CliTerminalFormatter.finishEventStream(outputTarget);
        CliTerminalFormatter.renderStats(stats);
      })
    );
    instance.onPromptStart((data) =>
      outputGate.write(() => {
        if (data.cliCommand !== undefined) {
          CliTerminalFormatter.renderPromptHeader(data);
          return;
        }

        const state = getParallelGroup(data.parallelGroupId);
        if (!state) {
          renderPromptHeader(data);
          return;
        }
        if (!state.started.has(data.stepIndex)) {
          state.started.add(data.stepIndex);
          CliTerminalFormatter.renderParallelGroupHeader(
            state.group,
            state.memberCount
          );
        }
        // A retry re-opens a branch that was tentatively settled by its prior
        // attempt. The tally therefore remains truthful while branches stream
        // concurrently into one linear terminal.
        state.completed.delete(data.stepIndex);
        state.failed.delete(data.stepIndex);
        renderParallelGroupProgress(state);
        renderPromptHeader(data);
      })
    );
    instance.onTargetScriptOutput((data) =>
      outputGate.write(() => {
        renderFinalStepLabel(data.target);
        const statusSummary =
          CliTerminalFormatter.getScriptVerdictStatusSummary(data.output);
        if (statusSummary) {
          pendingScriptStatusMessages.set(
            statusSummary,
            (pendingScriptStatusMessages.get(statusSummary) ?? 0) + 1
          );
        }
        CliTerminalFormatter.renderScriptOutput(
          data.output,
          toCliOutputTarget(
            data.target,
            getCliOutputStepName(instance, data.target)
          )
        );
      })
    );
    instance.onTargetStreamingEvents((data) => {
      if (data.executionMode === EXECUTION_MODES.INTERACTIVE) {
        return;
      }
      outputGate.write(() => {
        renderFinalStepLabel(data.target);
        CliTerminalFormatter.renderEvents(
          data.events,
          toCliOutputTarget(data.target, data.stepName)
        );
      });
    });
    instance.onTargetStreamingChunk((data) => {
      if (data.executionMode === EXECUTION_MODES.INTERACTIVE) {
        return;
      }
      outputGate.write(() => {
        renderFinalStepLabel(data.target);
        CliTerminalFormatter.renderStreamingChunk(
          data.chunk,
          toCliOutputTarget(data.target, data.stepName)
        );
      });
    });
    instance.onWorkflowStatusMessage((data) =>
      outputGate.write(() => {
        if (data.severity === STATUS_MESSAGE_SEVERITY.ERROR) {
          const state = getParallelGroup(
            instance.promptQueue
              .getState()
              .parallelGroups.find(
                (group) =>
                  data.stepIndex >= group.startIndex &&
                  data.stepIndex <= group.endIndex
              )?.id
          );
          if (state?.started.has(data.stepIndex)) {
            state.completed.delete(data.stepIndex);
            state.failed.add(data.stepIndex);
            renderParallelGroupProgress(state);
          }
        }
        const pendingCount = pendingScriptStatusMessages.get(data.message) ?? 0;
        if (pendingCount > 0) {
          if (pendingCount === 1) {
            pendingScriptStatusMessages.delete(data.message);
          } else {
            pendingScriptStatusMessages.set(data.message, pendingCount - 1);
          }
          return;
        }
        CliTerminalFormatter.renderStatusMessage(data.message, data.severity);
      })
    );
    instance.onPromptComplete((data) =>
      outputGate.write(() => {
        const state = getParallelGroup(data.parallelGroupId);
        if (state?.started.has(data.stepIndex)) {
          if (!state.failed.has(data.stepIndex)) {
            state.completed.add(data.stepIndex);
            renderParallelGroupProgress(state);
          }
        }
      })
    );
  }

  // Runner-lock acquire/heartbeat/release is owned entirely by
  // WorkflowInstance.startWorkflowExecution (single owner across CLI and
  // extension — see WorkflowLockManager). The CLI no longer duplicates it here.

  // Handle Ctrl+C gracefully — shutdown() requests a stop and waits (with a
  // bounded timeout) for the in-flight execution to actually settle, which is
  // what guarantees the runner lock has been released before we exit.
  const cleanup = async (): Promise<void> => {
    if (!options.quiet && !options.json) {
      console.log(chalk.yellow("\n\nInterrupted. Stopping workflow..."));
    }
    await instance.shutdown();
    // Flush any pending retry aggregate so an interrupted run still reports the
    // attempts it made. Idempotent with the normal and error exit paths.
    releaseLiveOutputState();
    process.exit(5);
  };
  process.on("SIGINT", () => {
    void cleanup();
  });
  process.on("SIGTERM", () => {
    void cleanup();
  });

  try {
    if (operation.kind === CLI_RUN_OPERATION_KINDS.RUN) {
      if (options.prompt) {
        instance.loadPromptString(options.prompt);
      } else {
        const loaded = await instance.loadPromptFile(resolvedFile!);
        if (!loaded) {
          throw new Error(`Failed to load workflow file: ${resolvedFile}`);
        }
        assertWorkflowExternalRootsApproved(
          instance.promptQueue.getWorkflowFile(),
          workingDir,
          getAuthoredSourcePath(resolvedFile!)
        );
      }

      const overrides = buildCliPropertyOverrides(options, harness);
      const workflow = instance.promptQueue.getWorkflowFile();
      const notices = applyCliPropertyOverrides(workflow, overrides);
      for (const key of Object.keys(overrides.workflow) as Array<
        keyof typeof overrides.workflow
      >) {
        instance.promptQueue.updateWorkflowProperty(key, workflow[key]);
      }
      if (Object.keys(overrides.workflow).length > 0) {
        await instance.promptQueue.updateWorkingFile(true);
      }
      if (!options.quiet && !options.json) {
        for (const notice of notices) console.log(chalk.yellow(notice));
      }

      printRunHeader();
      warnAboutClampedInteractiveSteps(
        instance.promptQueue.getWorkflowFile(),
        hostCanProvidePty
      );

      // Merge CLI --var flags into the workflow's vars (CLI vars take highest precedence).
      // This must happen after loading so the workflow's own vars: defaults are already set.
      if (Object.keys(config.vars).length > 0) {
        const workflowFile = instance.promptQueue.getWorkflowFile();
        mergeCliVarsIntoWorkflow(workflowFile, config.vars);
        instance.promptQueue.updateWorkflowProperty("vars", workflowFile.vars);
        await instance.promptQueue.updateWorkingFile(true);
      }

      assertSecretGrantsApproved(
        instance.promptQueue.getWorkflowFile(),
        workingDir
      );

      await instance.executeLoadedPromptFile();
    } else {
      await executeAddressedCliOperation(
        operation,
        options,
        workingDir,
        platform,
        instance,
        hostCanProvidePty,
        userFeedbackSink,
        printRunHeader
      );
    }

    releaseLiveOutputState();

    const state = instance.promptQueue.getState();
    const schemaRefusal = runStateRefusals.first();
    const exitCode = applyRunStateRefusal(
      getExitCode(state, instance.promptQueue.getFinalStepRuntime()),
      schemaRefusal
    );
    const completed = exitCode === 0;

    if (options.json) {
      const promptFile = instance.promptQueue.getWorkflowFile();
      const outputProjection = await resolveCliJsonOutputProjection(
        instance,
        state,
        workingDir
      );
      const result = buildCliJsonResult({
        state,
        promptFile,
        ...resolveCliRunHarnessAndModel(
          getCliReportingWorkflow(
            instance.promptQueue.getWorkflowFile(),
            operation,
            options
          ),
          harness
        ),
        workflowFileReference: file,
        workspaceRoot: workingDir,
        outputProjection,
        finalStepRuntime: instance.promptQueue.getFinalStepRuntime(),
      });
      process.stdout.write(JSON.stringify(result) + "\n");
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
      const workflowFile =
        instance.promptQueue.getWorkflowFile() as WorkingFile;
      CliTerminalFormatter.renderRunSummary(
        state.runRef,
        state.tokenTotals,
        projectWorktreeRuntime(workflowFile._runtime?.worktree)
      );
    }
    if (!completed && schemaRefusal) {
      // stderr in every mode: `--json` stdout stays one JSON document.
      console.error(chalk.red("Error: " + schemaRefusal.message));
    }

    process.exit(exitCode);
  } catch (err) {
    releaseLiveOutputState();
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      const state = instance.getQueueState();
      const result = buildCliJsonResult({
        state: undefined,
        promptFile: instance.promptQueue.getWorkflowFile(),
        ...resolveCliRunHarnessAndModel(
          getCliReportingWorkflow(
            instance.promptQueue.getWorkflowFile(),
            operation,
            options
          ),
          harness
        ),
        workflowFileReference: file,
        workspaceRoot: workingDir,
        workflowKey: state.workflowKey,
        runRef: state.runRef,
        error: err,
      });
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      console.error(chalk.red("Error: " + message));
    }
    process.exit(2);
  }
}

/**
 * Run a history or status command. Their output is commonly piped into `head`
 * or `grep -m`, so a reader closing stdout early ends the command quietly.
 */
function handleHistoryCommand(operation: Promise<void>): Promise<void> {
  exitQuietlyOnClosedPipe();
  return operation.catch((error: unknown) => {
    if (isClosedPipeError(error)) process.exit(CLI_CLOSED_PIPE_EXIT_CODE);
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(2);
  });
}

function createHistoryCommandIo(): HistoryCommandIo {
  return {
    writeOut: (message) => console.log(message),
    writeErr: (message) => console.error(chalk.yellow(message)),
    isInteractive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    confirm: promptYesNo,
  };
}

function createHistoryInspectionCommandIo(): HistoryInspectionCommandIo {
  return {
    writeOut: (message) => console.log(message),
    writeErr: (message) => console.error(message),
    writeErrProgress: (message) => process.stderr.write(message),
    isErrTty: !!process.stderr.isTTY,
  };
}

function handleStepCommand(
  operation: Promise<void>,
  json: boolean
): Promise<void> {
  return operation.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(
        JSON.stringify({ schemaVersion: 1, success: false, error: message }) +
          "\n"
      );
    } else {
      console.error(chalk.red(`Error: ${message}`));
    }
    process.exit(2);
  });
}

async function prepareStepCommand(
  options: StepEditOptions | StepRemoveOptions | StepReorderOptions
) {
  const workspace = await bootstrapCliWorkspace(options);
  return createStepCommandContext(
    workspace.workspaceRoot,
    cliRunnerHostIdentity
  );
}

function handleSecretCommand(operation: Promise<void | number>): Promise<void> {
  return operation
    .then((exitCode) => {
      if (typeof exitCode === "number") {
        process.exit(exitCode);
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        chalk.red(secretRedactionService.redactText(`Error: ${message}`))
      );
      process.exit(2);
    });
}

function mergeCliVarsIntoWorkflow(
  workflow: PromptFile,
  vars: Record<string, string>
): void {
  if (Object.keys(vars).length === 0) {
    return;
  }
  const mergedVars = { ...(workflow.vars ?? {}), ...vars };
  const variableKeyErrors = getVariableKeyErrors(Object.keys(mergedVars));
  if (variableKeyErrors.length > 0) {
    throw new Error(
      `Invalid workflow variables: ${variableKeyErrors.join(", ")}`
    );
  }
  workflow.vars = mergedVars;
}

function assertSecretGrantsApproved(
  workflow: PromptFile,
  workingDir: string
): void {
  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workingDir);
  const pendingGrants = secretGrantsTrustStore.getPendingGrants(
    workspaceIdentity,
    getWorkflowSecretGrants(workflow)
  );
  if (pendingGrants.length === 0) {
    return;
  }

  console.error(
    chalk.red(
      "Error: This workflow requests secret grants that have not been approved yet:"
    )
  );
  pendingGrants.forEach((name) => console.error(chalk.red(`  - ${name}`)));
  console.error(
    chalk.yellow(
      "Run `ctrlyoke trust-secret-grants <file>` to review and approve them."
    )
  );
  process.exit(2);
}

function assertWorkflowExternalRootsApproved(
  workflow: PromptFile,
  workingDir: string,
  authoredSourcePath: string
): void {
  if (
    workflow.trustedExternalRoots === undefined ||
    workflow.trustedExternalRoots === null
  ) {
    return;
  }

  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workingDir);
  const workflowIdentity = ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
    workingDir,
    authoredSourcePath
  );
  const pendingRoots = ConfigurationUtils.getPendingWorkflowExternalFileRoots(
    workspaceIdentity,
    workflowIdentity,
    workflow.trustedExternalRoots
  );
  if (pendingRoots.length === 0) {
    return;
  }

  console.error(
    chalk.red(
      "Error: This workflow requests external file roots that have not been approved yet:"
    )
  );
  pendingRoots.forEach((root) => console.error(chalk.red(`  - ${root}`)));
  console.error(
    chalk.yellow(
      "Run `ctrlyoke trust-workflow-external-roots <file>` to review and approve them."
    )
  );
  process.exit(2);
}

async function dryRunCommand(
  resolvedFile: string | undefined,
  options: RunOptions,
  config: ResolvedCliConfig,
  harness: HarnessId,
  workingDir: string,
  hostCanProvidePty: boolean,
  supportsConcurrentInteractiveSessions: boolean,
  platform: CliAdapter,
  factory: IntegrationFactory,
  userFeedbackSink: ConsoleUserFeedbackSink
): Promise<void> {
  try {
    assertHarnessId(harness);
    const parser = new PromptFileParser(platform, userFeedbackSink);
    const workflow: PromptFile | null = options.prompt
      ? { steps: [{ prompt: options.prompt }] }
      : await parser.parsePromptFile(resolvedFile!);
    if (!workflow) {
      throw new Error(
        parser.lastNewerSchemaError?.message ??
          `Failed to load workflow file: ${resolvedFile}`
      );
    }

    const overrides = buildCliPropertyOverrides(options, harness);
    const notices = applyCliPropertyOverrides(workflow, overrides);
    if (!options.quiet && !options.json) {
      for (const notice of notices) console.log(chalk.yellow(notice));
    }

    if (resolvedFile) {
      assertWorkflowExternalRootsApproved(
        workflow,
        workingDir,
        getAuthoredSourcePath(resolvedFile)
      );
    }

    mergeCliVarsIntoWorkflow(workflow, config.vars);
    assertSecretGrantsApproved(workflow, workingDir);

    const previewWorkflow = workflow;
    collectWorkflowHarnesses(previewWorkflow, harness);
    const capabilityRegistry = createCliCapabilityRegistry();
    let capabilities;
    try {
      capabilities = await capabilityRegistry.getSnapshot();
    } finally {
      capabilityRegistry.dispose();
    }
    const defaultsContext = PropertyResolver.createContext({
      hostCanProvidePty,
    });
    const defaults = {
      ...defaultsContext.defaults,
      harness,
      modelsByHarness: defaultsContext.defaults.modelsByHarness,
    };
    const integrations = new Map<
      HarnessId,
      ReturnType<IntegrationFactory["createForPreview"]>
    >();
    const outputHistoryManager = new OutputHistoryManager(workingDir);
    const runAddress = resolvedFile
      ? WorkflowPaths.parseRunFilePath(workingDir, resolvedFile)
      : undefined;
    const historyFilePath = runAddress
      ? outputHistoryManager.getHistoryFilePath(
          runAddress.workflowKey,
          runAddress.runRef
        )
      : "";
    const service = new ExecutionPreviewService({
      defaults,
      capabilities,
      getHarness: (harnessId, executionWorkspace) => {
        let integration = integrations.get(harnessId);
        if (!integration) {
          integration = factory.createForPreview(harnessId, executionWorkspace);
          integrations.set(harnessId, integration);
        }
        return integration.getExecutionPreviewHarness();
      },
      workspaceRoot: workingDir,
      workspaceRoots: platform.getWorkspaceRoots(),
      approvedExternalRoots:
        platform.getApprovedExternalFileRoots?.(workingDir),
      namedWorkspaceRoots: platform.getNamedWorkspaceRoots(),
      extensionPath: platform.getExtensionPath(),
      hostCanProvidePty,
      supportsConcurrentInteractiveSessions,
      cwd: workingDir,
      platform: process.platform,
      dynamicQueueConfig: ConfigurationUtils.getDynamicQueueConfig(),
      resolvePriorContextItems: createPriorContextResolver({
        workspaceRoot: workingDir,
        historyFilePath,
        outputResolver: outputHistoryManager.getRunOutputResolver(),
      }),
    });

    let preview: WorkflowExecutionPreview;
    try {
      preview = await service.build({
        workflow: previewWorkflow,
        sourcePath: resolvedFile,
        sourceDefinitionPath: resolvedFile,
        variables: config.vars,
      });
    } finally {
      for (const integration of integrations.values()) {
        integration.dispose();
      }
    }

    const output = buildCliPreviewJsonResult(preview);
    if (options.json) {
      process.stdout.write(JSON.stringify(output) + "\n");
    } else if (!options.quiet) {
      CliTerminalFormatter.renderExecutionPreview(output);
    }

    const hasErrors = output.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
    );
    process.exit(hasErrors ? 1 : 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red("Error: " + message));
    process.exit(2);
  }
}

function collectWorkflowHarnesses(
  workflow: PromptFile,
  defaultHarness: HarnessId
): Set<HarnessId> {
  const values = [
    defaultHarness,
    workflow.harness,
    ...(workflow.steps ?? [])
      .filter((step) => !isScriptStep(step))
      .map((step) => step.harness),
    ...(workflow.finalStep && !isScriptStep(workflow.finalStep)
      ? [workflow.finalStep.harness]
      : []),
  ].filter((value): value is HarnessId => value !== undefined);
  for (const value of values) {
    assertHarnessId(value);
  }
  return new Set(values as HarnessId[]);
}

function isRunCommandOptions(
  options: RunOptions | RerunOptions | AppendOptions | ContinueOptions
): options is RunOptions {
  return "dryRun" in options;
}

function createCliCapabilityRegistry(): HarnessCapabilityRegistry {
  const registry = new HarnessCapabilityRegistry({
    sourceFactory: (harnessId): HarnessCapabilitySource => {
      const provider = IntegrationFactory.createCapabilityProvider(harnessId);
      return {
        provider: {
          config: provider.config,
          capabilities: provider.capabilities,
          // Dry-run must not launch a harness, including a --version probe.
          // Static declarations are therefore intentionally unverified; the
          // shared analyzer still reports their exact fidelity diagnostics.
          checkAvailability: async () => true,
        },
      };
    },
  });
  return registry;
}

async function resolveCliJsonOutputProjection(
  instance: WorkflowInstance,
  state: QueueState,
  workspaceRoot: string
) {
  if (!state.workflowKey || !state.runRef) {
    return undefined;
  }

  const workflowFile = instance.promptQueue.getWorkflowFile();
  const finalStepRuntime = instance.promptQueue.getFinalStepRuntime();
  const finalLoopCount = finalStepRuntime
    ? finalStepRuntime.phase === FINAL_STEP_PHASES.FINAL_STEP
      ? finalStepRuntime.loopCount + 1
      : finalStepRuntime.loopCount
    : 0;
  const queueTargets: OutputExecutionTarget[] = state.steps.map(
    (_, stepIndex) => ({
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex,
    })
  );
  const finalStepTargets: OutputExecutionTarget[] = workflowFile.finalStep
    ? Array.from({ length: finalLoopCount }, (_, loopIndex) => ({
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex,
      }))
    : [];
  const manifestPath = instance
    .getOutputHistoryManager()
    .getHistoryFilePath(state.workflowKey, state.runRef);

  return instance
    .getOutputHistoryManager()
    .getRunOutputResolver()
    .resolveAttemptProjection(manifestPath, queueTargets, finalStepTargets, {
      workspaceRoot,
      approvedExternalRoots:
        ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
          ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot)
        ),
    });
}

async function executeAddressedCliOperation(
  operation: Exclude<
    CliRunOperation,
    { kind: typeof CLI_RUN_OPERATION_KINDS.RUN }
  >,
  options: RunOptions | RerunOptions | AppendOptions | ContinueOptions,
  workspaceRoot: string,
  platform: CliAdapter,
  instance: WorkflowInstance,
  hostCanProvidePty: boolean,
  userFeedbackSink: ConsoleUserFeedbackSink,
  onWorkflowLoaded: () => void
): Promise<void> {
  const workflowKey = await resolveCliWorkflowKey(
    workspaceRoot,
    new WorkflowLineageRepository(),
    operation.workflow,
    (message) => console.error(message)
  );
  const history = new OutputHistoryManager(workspaceRoot);
  const lineageRepository = new WorkflowLineageRepository();
  const warnIfNeeded = async (): Promise<void> => {
    onWorkflowLoaded();
    warnAboutClampedInteractiveSteps(
      instance.promptQueue.getWorkflowFile(),
      hostCanProvidePty
    );
  };

  if (operation.kind === CLI_RUN_OPERATION_KINDS.RERUN) {
    const sourceRunRef = await resolveCliRunRefAtLineage(
      workspaceRoot,
      history,
      workflowKey,
      operation.from,
      "--from"
    );
    await assertLineageAvailableForCli(workspaceRoot, workflowKey);
    const descriptor = await lineageRepository.readDescriptor(
      workspaceRoot,
      workflowKey
    );
    const source = await readRunDefinition(
      workspaceRoot,
      workflowKey,
      sourceRunRef
    );
    const seeded = await WorkingFileManager.seedNewRun(
      workspaceRoot,
      workflowKey,
      sourceRunRef,
      {},
      lineageRepository,
      {
        definitionRevision: source.definitionRevision ?? 1,
        descriptorRevision: descriptor.revision,
      },
      // This seed is executed on the next line, so the manifest opens RUNNING.
      EXECUTION_STATES.RUNNING
    );
    await instance.executeSeededRun(
      seeded,
      workflowKey,
      undefined,
      async () => {
        await applyAddressedCliPropertyOverrides(
          instance,
          options,
          ConfigurationUtils.getIntegrationMode(),
          true
        );
        await warnIfNeeded();
      }
    );
    return;
  }

  const runRef = await resolveCliRunRefAtLineage(
    workspaceRoot,
    history,
    workflowKey,
    operation.run,
    "--run"
  );
  const target = await validateCliContinuationTarget(
    workspaceRoot,
    workflowKey,
    runRef,
    lineageRepository,
    operation.kind === CLI_RUN_OPERATION_KINDS.APPEND
      ? RUN_CONTINUATION_ACTIONS.APPEND
      : RUN_CONTINUATION_ACTIONS.CONTINUE
  );

  if (operation.kind === CLI_RUN_OPERATION_KINDS.APPEND) {
    const tail = await parseAppendTail(
      operation,
      options as AppendOptions,
      platform,
      userFeedbackSink
    );
    const appended = await RunContinuationService.appendStepsToRun(
      workspaceRoot,
      workflowKey,
      runRef,
      tail,
      target.definitionRevision,
      ConfigurationUtils.getGlobalMaxSteps(),
      lineageRepository,
      target.allowInterruptedRun
    );
    const unapprovedGrants = findUnapprovedStepSecretGrants(
      tail,
      appended.workingFile,
      workspaceRoot
    );
    if (unapprovedGrants.length > 0) {
      console.error(
        chalk.yellow(
          formatAppendedUnapprovedSecretGrantsWarning(unapprovedGrants)
        )
      );
    }
    await instance.executeContinuationAtRun(
      workflowKey,
      runRef,
      appended.definitionRevision,
      async () => {
        await applyAddressedCliPropertyOverrides(
          instance,
          options,
          ConfigurationUtils.getIntegrationMode(),
          false
        );
        await warnIfNeeded();
      }
    );
    return;
  }

  await instance.executeContinuationAtRun(
    workflowKey,
    runRef,
    target.definitionRevision,
    async () => {
      await applyAddressedCliPropertyOverrides(
        instance,
        options,
        ConfigurationUtils.getIntegrationMode(),
        false
      );
      await warnIfNeeded();
    }
  );
}

async function applyAddressedCliPropertyOverrides(
  instance: WorkflowInstance,
  options: RunOptions | RerunOptions | AppendOptions | ContinueOptions,
  defaultHarness: HarnessId,
  includeHarnessAndModel: boolean
): Promise<void> {
  const workflow = instance.promptQueue.getWorkflowFile();
  const overrides = buildCliPropertyOverrides(
    includeHarnessAndModel
      ? options
      : { ...options, harness: undefined, model: undefined },
    defaultHarness
  );
  const originalModel = workflow.model;
  const notices = applyCliPropertyOverrides(workflow, overrides);
  const workflowProperties: Record<string, unknown> = {
    ...overrides.workflow,
  };
  if (overrides.workflow.toolPermissions) {
    workflowProperties.toolPermissions = workflow.toolPermissions;
  }
  if (originalModel !== undefined && workflow.model === undefined) {
    workflowProperties.model = undefined;
  }
  if (Object.keys(workflowProperties).length > 0) {
    await instance.promptQueue.updateWorkingFileProperties(workflowProperties, {
      allowDeletes: true,
    });
  }
  if (overrides.forced.size > 0) {
    await instance.promptQueue.updateWorkingFile(true);
  }
  if (!options.quiet && !options.json) {
    for (const notice of notices) console.log(chalk.yellow(notice));
  }
}

async function parseAppendTail(
  operation: Extract<CliRunOperation, { kind: "append" }>,
  options: AppendOptions,
  platform: CliAdapter,
  userFeedbackSink: ConsoleUserFeedbackSink
): Promise<WorkflowStep[]> {
  let steps: WorkflowStep[];
  if (options.prompt) {
    steps = [{ prompt: options.prompt }];
  } else {
    if (!operation.file) {
      throw new Error("Append source was not provided");
    }
    const parsed = await parseCliPromptFile(
      operation.file,
      platform,
      userFeedbackSink
    );
    if (!parsed.steps?.length) {
      throw new Error("Append source must contain at least one workflow step");
    }
    steps = parsed.steps;
  }

  return applyCliAppendOverrides(
    steps,
    options.harness as HarnessId | undefined,
    options.model
  );
}

async function assertLineageAvailableForCli(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): Promise<void> {
  const lockInspection = await readWorkflowLockInspection(
    workspaceRoot,
    workflowKey
  );
  if (lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE) {
    throw new Error("Another run in this workflow lineage is executing");
  }
}

async function validateCliContinuationTarget(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef,
  lineageRepository: WorkflowLineageRepository,
  action:
    | typeof RUN_CONTINUATION_ACTIONS.APPEND
    | typeof RUN_CONTINUATION_ACTIONS.CONTINUE
): Promise<{
  definitionRevision: number;
  descriptorRevision: number;
  allowInterruptedRun: boolean;
}> {
  return RunContinuationService.validateContinuationTarget(
    workspaceRoot,
    workflowKey,
    runRef,
    lineageRepository,
    action,
    false,
    cliRunnerHostIdentity
  );
}

async function readRunDefinition(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef
): Promise<WorkingFile> {
  try {
    return JSON.parse(
      await readFile(
        WorkflowPaths.runFilePath(workspaceRoot, workflowKey, runRef),
        "utf8"
      )
    ) as WorkingFile;
  } catch (error) {
    throw new Error(
      `Failed to read run ${workflowKey}/${runRef}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function validateCommand(
  file: string,
  options: ValidateCommandOptions = {}
): Promise<void> {
  Log.initializeCli(process.cwd(), false);
  const resolvedFile = resolveCliFileArgument(file);
  const compatibilityRequested =
    options.harness !== undefined || options.allInstalledHarnesses === true;

  let strictPolicy: CliValidateStrictPolicy | undefined;
  let target: CliValidationTarget | undefined;
  try {
    if (options.harness && options.allInstalledHarnesses) {
      throw new Error(
        "--harness and --all-installed-harnesses cannot be used together"
      );
    }
    if (options.harness) {
      assertHarnessId(options.harness);
      target = {
        kind: CLI_VALIDATE_TARGET_KINDS.HARNESS,
        harness: options.harness,
      };
    } else if (options.allInstalledHarnesses) {
      target = { kind: CLI_VALIDATE_TARGET_KINDS.ALL_INSTALLED_HARNESSES };
    }
    if (typeof options.strict === "string") {
      if (!compatibilityRequested) {
        throw new Error(
          "--strict <policy> requires --harness or --all-installed-harnesses"
        );
      }
      strictPolicy = parseCliValidateStrictPolicy(options.strict);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          buildCliValidationJsonResult({
            success: false,
            parsed: false,
            workflowFile: resolvedFile,
            error: message,
          })
        ) + "\n"
      );
    } else {
      console.error(chalk.red(`Error: ${message}`));
    }
    process.exit(2);
    return;
  }

  // Check file existence before invoking the parser to avoid internal Log.error() noise.
  try {
    await access(resolvedFile);
  } catch {
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          buildCliValidationJsonResult({
            success: false,
            parsed: false,
            workflowFile: resolvedFile,
            error: `File not found: ${resolvedFile}`,
          })
        ) + "\n"
      );
    } else {
      console.error(chalk.red(`Error: File not found: ${resolvedFile}`));
    }
    process.exit(2);
    return;
  }

  try {
    const { PromptFileParser } = await import("./core/PromptFileParser.js");
    const parser = new PromptFileParser();
    const result = await parser.parsePromptFile(resolvedFile);
    if (!result) {
      const newerSchemaError = parser.lastNewerSchemaError;
      if (newerSchemaError) {
        if (options.json) {
          process.stdout.write(
            JSON.stringify(
              buildCliValidationJsonResult({
                success: false,
                parsed: false,
                workflowFile: resolvedFile,
                error: newerSchemaError.message,
                errorCode: CLI_VALIDATE_ERROR_CODES.WORKFLOW_NEWER_FORMAT,
              })
            ) + "\n"
          );
        } else {
          console.error(newerSchemaError.message);
        }
        process.exit(2);
        return;
      }
      const message =
        parser.lastParseError?.message ??
        `${path.basename(resolvedFile)} failed validation`;
      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            buildCliValidationJsonResult({
              success: false,
              parsed: false,
              workflowFile: resolvedFile,
              error: message,
            })
          ) + "\n"
        );
      } else {
        console.error(chalk.red(`✗ ${message}`));
      }
      process.exit(2);
      return;
    }

    // Ajv proves the file's shape; this is the semantic pass the dashboard runs
    // on load, so the CLI reports the same errors instead of calling a workflow
    // valid that the extension would refuse. Its warnings never fail the run —
    // the workflow loads and executes, something in it just will not take
    // effect — so they are reported whether or not compatibility was requested.
    const stepValidation = parser.validateWorkflowSteps(result.steps ?? [], {
      finalStep: result.finalStep,
      parallelGroups: result.parallelGroups,
      workflowProperties: result,
    });
    const warnings = [...result.warnings, ...stepValidation.warnings];

    if (options.strict !== undefined && result.warnings.length > 0) {
      const message = `Unknown workflow fields are errors in strict mode: ${result.warnings.map((warning) => warning.propertyPointer).join(", ")}`;
      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            buildCliValidationJsonResult({
              success: false,
              parsed: true,
              workflowFile: resolvedFile,
              warnings,
              error: message,
            })
          ) + "\n"
        );
      } else {
        console.error(
          chalk.red(`✗ ${path.basename(resolvedFile)} failed validation`)
        );
        renderCliValidationWarnings(warnings);
        console.error(chalk.red(`  ${message}`));
      }
      process.exit(2);
      return;
    }

    if (!stepValidation.valid) {
      const message = stepValidation.errors.join("; ");
      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            buildCliValidationJsonResult({
              success: false,
              parsed: true,
              workflowFile: resolvedFile,
              warnings,
              error: message,
            })
          ) + "\n"
        );
      } else {
        console.error(
          chalk.red(`✗ ${path.basename(resolvedFile)} failed validation`)
        );
        for (const error of stepValidation.errors) {
          console.error(chalk.red(`  ${error}`));
        }
      }
      process.exit(2);
      return;
    }

    if (!compatibilityRequested) {
      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            buildCliValidationJsonResult({
              success: true,
              parsed: true,
              workflowFile: resolvedFile,
              consumerCount: 0,
              warnings,
            })
          ) + "\n"
        );
      } else {
        console.log(chalk.green(`✓ ${path.basename(resolvedFile)} is valid`));
        console.log(chalk.dim(`  ${result.steps?.length ?? 1} prompt(s)`));
        renderCliValidationWarnings(warnings);
      }
      process.exit(0);
      return;
    }

    const workingDir = process.cwd();
    Log.initializeCli(workingDir, false);
    configService.setUserBackend(createUserConfigBackend());
    configService.setWorkspaceBackend(createWorkspaceConfigBackend(workingDir));
    configService.setCliOverlay({});

    const capabilityRegistry = new HarnessCapabilityRegistry();
    try {
      const capabilities = await capabilityRegistry.getSnapshot();
      const harnesses = selectCliValidationHarnesses(target!, capabilities);
      const analysis = analyzeCliCompatibility(
        result,
        capabilities,
        harnesses,
        undefined,
        {
          allInstalled:
            target!.kind === CLI_VALIDATE_TARGET_KINDS.ALL_INSTALLED_HARNESSES,
        }
      );
      const failed = hasCliValidationFailures(
        analysis.diagnostics,
        strictPolicy
      );
      const jsonTarget = createCliValidationJsonTarget(
        target!,
        harnesses,
        capabilities
      );

      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            buildCliValidationJsonResult({
              success: !failed,
              parsed: true,
              workflowFile: resolvedFile,
              target: jsonTarget,
              strict: strictPolicy,
              consumerCount: analysis.consumerCount,
              diagnostics: analysis.diagnostics,
              warnings,
            })
          ) + "\n"
        );
      } else {
        renderCliCompatibilityValidation(
          resolvedFile,
          result,
          target!,
          harnesses,
          capabilities,
          strictPolicy,
          analysis.consumerCount,
          analysis.diagnostics
        );
        renderCliValidationWarnings(warnings);
      }
      process.exit(failed ? 1 : 0);
    } finally {
      capabilityRegistry.dispose();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          buildCliValidationJsonResult({
            success: false,
            parsed: true,
            workflowFile: resolvedFile,
            error: message,
          })
        ) + "\n"
      );
    } else {
      console.error(chalk.red("Error: " + message));
    }
    process.exit(2);
  }
}

/**
 * Workflow warnings, printed under whichever validation summary ran. Unknown
 * property warnings become errors in strict mode; other findings remain
 * non-blocking and harness-independent.
 */
function renderCliValidationWarnings(
  warnings: readonly WorkflowValidationWarning[]
): void {
  if (warnings.length === 0) {
    return;
  }
  console.log(
    chalk.yellow(
      `  ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`
    )
  );
  for (const warning of warnings) {
    console.log(chalk.yellow(`  ⚠ ${warning.message}`));
    console.log(chalk.dim(`    ${warning.propertyPointer} (${warning.code})`));
  }
}

function createCliValidationJsonTarget(
  target: CliValidationTarget,
  harnesses: readonly HarnessId[],
  capabilities: Awaited<ReturnType<HarnessCapabilityRegistry["getSnapshot"]>>
): NonNullable<ReturnType<typeof buildCliValidationJsonResult>["target"]> {
  const selectedHarnesses: CliValidationJsonHarness[] = harnesses.map(
    (harnessId) => ({
      harnessId,
      available: capabilities.harnesses[harnessId]?.available === true,
      version: capabilities.harnesses[harnessId]?.version ?? null,
    })
  );
  return { kind: target.kind, harnesses: selectedHarnesses };
}

function renderCliCompatibilityValidation(
  resolvedFile: string,
  workflow: PromptFile,
  target: CliValidationTarget,
  harnesses: readonly HarnessId[],
  capabilities: Awaited<ReturnType<HarnessCapabilityRegistry["getSnapshot"]>>,
  strictPolicy: CliValidateStrictPolicy | undefined,
  consumerCount: number,
  diagnostics: readonly CompatibilityDiagnostic[]
): void {
  console.log(chalk.green(`✓ ${path.basename(resolvedFile)} is valid`));
  const targetLabel =
    target.kind === CLI_VALIDATE_TARGET_KINDS.HARNESS
      ? `target harness ${getHarnessDisplayName(target.harness!)}`
      : `all installed harnesses (${harnesses.length})`;
  console.log(chalk.dim(`  Compatibility: ${targetLabel}`));
  if (strictPolicy) {
    console.log(chalk.dim(`  Strict policy: ${strictPolicy}`));
  }
  console.log(chalk.dim(`  AI consumers: ${consumerCount}`));
  if (target.kind === CLI_VALIDATE_TARGET_KINDS.ALL_INSTALLED_HARNESSES) {
    const versions = harnesses.map((harnessId) => {
      const version = capabilities.harnesses[harnessId]?.version;
      return `${getHarnessDisplayName(harnessId)}${version ? ` ${version}` : ""}`;
    });
    console.log(chalk.dim(`  Installed: ${versions.join(", ") || "none"}`));
  }

  for (const diagnostic of diagnostics) {
    const consumer = formatCompatibilityConsumer(workflow, diagnostic);
    const property = diagnostic.propertyPointer ?? diagnostic.capability;
    console.log(
      chalk.yellow(
        `  [${diagnostic.severity}] ${getHarnessDisplayName(diagnostic.harnessId)} — ${consumer} — ${property}`
      )
    );
    console.log(`    ${diagnostic.message}`);
    if (diagnostic.remediation) {
      console.log(chalk.dim(`    Remediation: ${diagnostic.remediation}`));
    }
  }
  if (diagnostics.length === 0) {
    console.log(chalk.green("  Compatibility: no findings"));
  }
}

function formatCompatibilityConsumer(
  workflow: PromptFile,
  diagnostic: CompatibilityDiagnostic
): string {
  if (!diagnostic.consumer) {
    return "workflow";
  }
  if (diagnostic.consumer.kind === FINAL_STEP_PHASES.FINAL_STEP) {
    return workflow.finalStep?.name?.trim() || "finalStep";
  }
  const step = workflow.steps?.[diagnostic.consumer.stepIndex];
  return step?.name?.trim() || `step ${diagnostic.consumer.stepIndex + 1}`;
}

/** Ask a y/N question on stderr (keeps stdout pipe-friendly). */
interface TrustExternalRootsOptions {
  cwd?: string;
  yes?: boolean;
}

interface TrustWorkflowExternalRootsOptions {
  cwd?: string;
  yes?: boolean;
}

/**
 * Review and approve this workspace's requested external file roots
 * (`permissions.trustedExternalRoots` at workspace scope). Ordinary
 * `ctrlyoke run` fails closed while any workspace-scope root is still
 * pending — see dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md.
 */
async function trustExternalRootsCommand(
  options: TrustExternalRootsOptions
): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  Log.initializeCli(workingDir, false);

  const userBackend = createUserConfigBackend();
  const workspaceBackend = createWorkspaceConfigBackend(workingDir);
  configService.setUserBackend(userBackend);
  configService.setWorkspaceBackend(workspaceBackend);

  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workingDir);
  const pendingRoots =
    ConfigurationUtils.getPendingWorkspaceExternalFileRoots(workspaceIdentity);

  if (pendingRoots.length === 0) {
    console.log(
      chalk.green(
        "No pending external file roots to approve for this workspace."
      )
    );
    process.exit(0);
  }

  console.log(
    chalk.bold(
      `This workspace requests ${pendingRoots.length} external file root(s):`
    )
  );
  pendingRoots.forEach((root) => console.log(`  - ${root}`));
  console.log();

  const approved =
    options.yes ||
    (await promptYesNo(
      `Trust all ${pendingRoots.length} listed folder(s)? [y/N] `
    ));

  if (!approved) {
    await externalRootsTrustStore.setDecisions(
      workspaceIdentity,
      pendingRoots,
      "deny"
    );
    console.log(
      chalk.yellow(
        "No roots were approved. They remain blocked — change this in Settings if needed."
      )
    );
    process.exit(0);
  }

  await externalRootsTrustStore.setDecisions(
    workspaceIdentity,
    pendingRoots,
    "allow"
  );
  console.log(
    chalk.green(
      `✓ Approved ${pendingRoots.length} external file root(s) for this workspace.`
    )
  );
  process.exit(0);
}

/**
 * Review and approve a workflow's requested `trustedExternalRoots`. Ordinary
 * `ctrlyoke run` fails closed while any workflow-scope root is still pending.
 */
async function trustWorkflowExternalRootsCommand(
  file: string,
  options: TrustWorkflowExternalRootsOptions
): Promise<void> {
  const workingDir = path.resolve(options.cwd ?? process.cwd());
  const resolvedFile = resolveCliFileArgument(file);
  Log.initializeCli(workingDir, false);

  const userBackend = createUserConfigBackend();
  const workspaceBackend = createWorkspaceConfigBackend(workingDir);
  configService.setUserBackend(userBackend);
  configService.setWorkspaceBackend(workspaceBackend);

  const parser = new PromptFileParser();
  const workflow = await parser.parsePromptFile(resolvedFile);
  if (!workflow) {
    console.error(
      chalk.red(
        parser.lastNewerSchemaError?.message ??
          `Error: Failed to load workflow file: ${resolvedFile}`
      )
    );
    process.exit(2);
  }

  if (
    workflow.trustedExternalRoots === undefined ||
    workflow.trustedExternalRoots === null
  ) {
    console.log(
      chalk.green(
        "No pending workflow external file roots to approve for this workflow."
      )
    );
    process.exit(0);
  }

  const workflowIdentity = ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
    workingDir,
    getAuthoredSourcePath(resolvedFile)
  );
  const pendingRoots = ConfigurationUtils.getPendingWorkflowExternalFileRoots(
    ExternalRootsTrustStore.canonicalizeRoot(workingDir),
    workflowIdentity,
    workflow.trustedExternalRoots
  );

  if (pendingRoots.length === 0) {
    console.log(
      chalk.green(
        "No pending workflow external file roots to approve for this workflow."
      )
    );
    process.exit(0);
  }

  console.log(
    chalk.bold(
      `This workflow requests ${pendingRoots.length} external file root(s):`
    )
  );
  pendingRoots.forEach((root) => console.log(`  - ${root}`));
  console.log();

  const approved =
    options.yes ||
    (await promptYesNo(
      `Trust all ${pendingRoots.length} listed folder(s)? [y/N] `
    ));
  const decision = approved ? "allow" : "deny";
  await externalRootsTrustStore.setDecisions(
    workflowIdentity,
    pendingRoots,
    decision
  );

  if (!approved) {
    console.log(
      chalk.yellow(
        "No roots were approved. They remain blocked — change this in Settings if needed."
      )
    );
    process.exit(0);
  }

  console.log(
    chalk.green(
      `✓ Approved ${pendingRoots.length} external file root(s) for this workflow.`
    )
  );
  process.exit(0);
}

interface CommitCommandOptions {
  model?: string;
  cwd?: string;
  hint?: string;
  printOnly?: boolean;
  all?: boolean;
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
    const overlay: PartialCtrlYokeSettings = {
      commit: { model: options.model },
    };
    configService.setCliOverlay(overlay);
  }

  const {
    CommitMessageGenerationError,
    CommitMessageGenerator,
    getMaxDiffSizeLabel,
  } = await import("./git/CommitMessageGenerator.js");
  if (!ConfigurationUtils.getCommitHarness()) {
    await IntegrationFactory.detectDefaultHarness();
  }
  const generator = new CommitMessageGenerator(
    undefined,
    cliRunnerHostIdentity
  );

  console.error(chalk.dim("Checking for changes..."));
  console.error(chalk.dim("Generating commit message..."));
  let diffResult;
  let message: string;
  try {
    const generated = await generateCommitMessageForChanges(
      generator,
      workingDir,
      options,
      options.hint
    );
    if (!generated.diffResult) {
      console.error("No changes detected. Stage or modify files first.");
      process.exit(0);
    }
    diffResult = generated.diffResult;
    message = generated.message;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${errMsg}`));
    if (
      err instanceof CommitMessageGenerationError &&
      err.workflowKey &&
      err.runRef
    ) {
      console.error(
        chalk.dim(
          `Inspect the persisted run events at: ${WorkflowPaths.eventsPath(workingDir, err.workflowKey, err.runRef)}`
        )
      );
    }
    process.exit(1);
  }

  if (diffResult.truncated) {
    console.error(
      chalk.yellow(
        `Warning: Diff exceeded ${getMaxDiffSizeLabel()} and was truncated. Commit message may be incomplete.`
      )
    );
  }

  if (options.printOnly) {
    // Pipe-friendly: only the message goes to stdout.
    //   git commit -m "$(ctrlyoke commit --print-only)"
    console.log(message);
    return;
  }

  console.error();
  console.error(chalk.bold("Generated commit message:"));
  console.error(chalk.dim("─".repeat(52)));
  console.error(message);
  console.error(chalk.dim("─".repeat(52)));
  console.error();

  if (!diffResult.staged && !options.all) {
    console.error(
      chalk.yellow(
        "Nothing is staged. Stage files and re-run, or use --all to stage all changes."
      )
    );
    process.exit(CLI_USAGE_EXIT_CODE);
  }

  const { GitCommitter } = await import("./git/GitCommitter.js");
  const committer = new GitCommitter();
  try {
    const result = await commitGeneratedChanges(
      diffResult,
      message,
      workingDir,
      options,
      committer,
      () => promptYesNo("Commit with this message? [y/N] ")
    );
    if (result === "aborted") {
      console.error("Aborted.");
      process.exit(0);
    }
    console.error(chalk.green("✓ Committed successfully"));
  } catch (err) {
    const execError = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const errorDetails = [
      err instanceof Error ? err.message : String(err),
      execError.stdout?.toString().trim(),
      execError.stderr?.toString().trim(),
    ].filter(Boolean);
    const errMsg = errorDetails.join("\n");
    console.error(chalk.red(`Error: ${errMsg}`));
    process.exit(1);
  }
}
