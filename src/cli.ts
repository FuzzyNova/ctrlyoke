import { ensureMinFsThreadpoolSize } from "./utils/ThreadPoolBootstrap";
ensureMinFsThreadpoolSize(64);

import { Command } from "commander";
import chalk from "chalk";
import * as path from "path";
import * as readline from "readline";
import { access, readFile } from "fs/promises";

import { CliAdapter } from "./platform/CliAdapter";
import { ConsoleUserFeedbackSink } from "./platform/ConsoleUserFeedbackSink";
import type { ResolvedCliConfig } from "./platform/CliAdapter";
import { registerCliAdapter } from "./platform/vscode-shim";
import { IntegrationFactory } from "./core/IntegrationFactory";
import { WorkflowInstance } from "./core/WorkflowInstance";
import {
  EXECUTION_STATES,
  STEP_STATUS,
  HARNESS_IDS,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  RUNNER_IDS,
  WORKFLOW_LOCK_LIVENESS,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CLI_VALIDATE_TARGET_KINDS,
  HARNESS_INFO,
  STATUS_MESSAGE_SEVERITY,
} from "./types/DashboardConstants";
import type {
  CliValidateStrictPolicy,
  HarnessId,
} from "./types/DashboardConstants";
import type { RunnerHostIdentity } from "./types/CtrlYokeTypes";
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
import {
  CliTerminalFormatter,
  type CliOutputTarget,
} from "./cli/CliTerminalFormatter";
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
import { RunContinuationService } from "./core/orchestration/RunContinuationService";
import { WorkflowLineageRepository } from "./core/orchestration/WorkflowLineageRepository";
import { OutputHistoryManager } from "./core/orchestration/OutputHistoryManager";
import { createPriorContextResolver } from "./core/orchestration/AddressedPriorContextResolver";
import {
  getAuthoredSourcePath,
  PromptFileParser,
} from "./core/PromptFileParser";
import { readWorkflowLockInspection } from "./utils/WorkflowLockInspector";
import * as WorkflowPaths from "./utils/WorkflowPaths";
import { resolveCliRunRefAtLineage } from "./cli/CliRunSelector";
import {
  registerRunCommand,
  registerRunScopedCommands,
  type AppendOptions,
  type ContinueOptions,
  type RerunOptions,
  type RunCommandOptions,
} from "./cli/CliRunCommandDefinitions";
import { registerHistoryCommands } from "./cli/HistoryCommandDefinitions";
import { registerStepCommands } from "./cli/StepCommandDefinitions";
import { registerSecretCommands } from "./cli/SecretCommandDefinitions";
import {
  pruneHistoryCommand,
  relinkHistoryCommand,
} from "./cli/HistoryCommands";
import {
  listHistoryCommand,
  runsHistoryCommand,
  searchHistoryCommand,
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
import { getWorkflowSecretGrants } from "./utils/SecretResolver";
import { resolveCliExecutionMode } from "./cli/CliExecutionMode";
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

const cliRunnerHostIdentity: RunnerHostIdentity = {
  runner: RUNNER_IDS.CLI,
  hostInstanceId: crypto.randomUUID(),
  pid: process.pid,
};

// VERSION is injected by esbuild define
declare const VERSION: string;
const version = typeof VERSION !== "undefined" ? VERSION : "0.0.0-dev";

const program = new Command();

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
  search: (query, options) =>
    handleHistoryCommand(
      searchHistoryCommand(query, options, createHistoryInspectionCommandIo())
    ),
});

registerStepCommands(program, {
  edit: (file, options) =>
    handleStepCommand(
      prepareStepCommand(options).then((context) =>
        editStepCommand(file, options, context, {
          writeOut: (message) => console.log(message),
        })
      ),
      options.json === true
    ),
  remove: (options) =>
    handleStepCommand(
      prepareStepCommand(options).then((context) =>
        removeStepCommand(options, context, {
          writeOut: (message) => console.log(message),
        })
      ),
      options.json === true
    ),
  reorder: (options) =>
    handleStepCommand(
      prepareStepCommand(options).then((context) =>
        reorderStepsCommand(options, context, {
          writeOut: (message) => console.log(message),
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
      checkSecretsCommand(
        file,
        options,
        createCliSecretCommandDependencies(
          path.resolve(options.cwd ?? process.cwd())
        ),
        createSecretCommandIo()
      )
    ),
  trustSecretGrants: (file, options) =>
    handleSecretCommand(
      trustSecretGrantsCommand(
        file,
        options,
        createCliSecretCommandDependencies(
          path.resolve(options.cwd ?? process.cwd())
        ),
        createSecretCommandIo()
      )
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

type RunOptions = RunCommandOptions;

interface CliParallelGroupState {
  group: ParallelGroupDefinition;
  memberCount: number;
  started: Set<number>;
  completed: Set<number>;
  failed: Set<number>;
}

interface CliAttemptState {
  stepName: string;
  attemptCount: number;
  totalElapsed: number;
  retried: boolean;
  activeAttemptCompleted: boolean;
}

/**
 * The workflow-level harness and model a run reports in its header and
 * `--json` result, using the precedence execution applies: an explicit
 * `--harness`/`--model` flag, then the workflow's own `harness`/`model`, then
 * the settings defaults. Individual steps may still name their own harness.
 */
function resolveCliRunHarnessAndModel(
  workflow: PromptFile | undefined,
  explicitHarness: HarnessId | undefined,
  defaultHarness: HarnessId,
  explicitModel: string | undefined
): { harness: HarnessId; model?: string } {
  const harness = explicitHarness ?? workflow?.harness ?? defaultHarness;
  const model =
    explicitModel ??
    workflow?.model ??
    ConfigurationUtils.getModelForHarness(harness);
  return { harness, ...(model ? { model } : {}) };
}

function getCliPromptExecutionDetails(
  instance: WorkflowInstance,
  stepIndex: number,
  defaults: Pick<ResolvedCliConfig, "harness" | "model">
): { harness?: HarnessId; model?: string } {
  const workflow = instance.promptQueue.getWorkflowFile();
  const step = instance.promptQueue.getState().steps[stepIndex];
  const promptStep = step && !isScriptStep(step) ? step : undefined;
  return {
    harness:
      step?._runtime?.harness ??
      promptStep?.harness ??
      workflow.harness ??
      (defaults.harness as HarnessId),
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
    : `Final Step Loop ${target.loopIndex + 1}`;
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

  const resolvedFile = file ? path.resolve(file) : undefined;
  const workingDir = options.cwd ?? process.cwd();

  // Redirect all Log.* output to .ctrlyoke/logs/ctrlyoke-<timestamp>.log.
  // Must be called before any component code that calls Log.debug/info/etc.,
  // so that diagnostic messages never pollute the terminal output.
  Log.initializeCli(workingDir, options.verbose);

  // Detect execution mode: explicit flags override TTY auto-detection
  const {
    executionMode,
    hostCanProvidePty,
    supportsConcurrentInteractiveSessions,
  } = resolveCliExecutionMode(
    options,
    !!process.stdout.isTTY,
    !!process.stdin.isTTY
  );

  // Tool permissions are not resolved here: --permission-mode/--allow-tool/
  // --deny-tool only enter the settings overlay below, so they resolve per step
  // like any other default (step > workflow > settings), independent of
  // execution mode.
  const config: ResolvedCliConfig = {
    harness: options.harness || HARNESS_IDS.COPILOT_CLI,
    model: options.model,
    cwd: workingDir,
    vars: options.var || {},
    sessionId: options.sessionId,
    resumeSession: options.resumeSession,
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
  // --harness has no Commander default, so its presence is always explicit.
  if (options.harness) {
    overlay.defaults = { harness: options.harness as HarnessId };
  }
  if (options.model) {
    overlay.defaults = {
      ...overlay.defaults,
      models: { [config.harness as HarnessId]: options.model },
    };
  }
  if (options.headless) {
    overlay.defaults = {
      ...overlay.defaults,
      executionMode: EXECUTION_MODES.HEADLESS,
    };
  } else if (options.interactive) {
    overlay.defaults = {
      ...overlay.defaults,
      executionMode: EXECUTION_MODES.INTERACTIVE,
    };
  } else {
    // Write TTY-detected execution mode to the overlay so that
    // ConfigurationUtils.getCliExecutionMode() always returns the effective value
    // regardless of what the user's config file says.
    overlay.defaults = { ...overlay.defaults, executionMode };
  }
  if (options.permissionMode) {
    overlay.defaults = {
      ...overlay.defaults,
      toolPermissions: {
        mode: options.permissionMode,
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

  const platform = new CliAdapter(config);
  const userFeedbackSink = new ConsoleUserFeedbackSink();
  // Register the adapter with the vscode-shim for backward compatibility.
  registerCliAdapter(platform);
  const factory = new IntegrationFactory(platform, userFeedbackSink);
  // The harness a workflow falls back to when neither a step nor the workflow
  // names one: the explicit --harness flag, else the defaults.harness setting
  // (which already carries the --harness overlay).
  const explicitHarness = options.harness as HarnessId | undefined;
  const harness = explicitHarness ?? ConfigurationUtils.getIntegrationMode();

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
        instance.promptQueue.getWorkflowFile(),
        explicitHarness,
        harness,
        config.model
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
    cliRunnerHostIdentity
  );

  // In headless mode, stream output to the terminal as events arrive.
  // Subscriptions go on the instance (not detectorIntegration) because WorkflowInstance
  // creates a fresh execution integration via the factory and forwards events from it.
  // Interactive mode passes the AI CLI's stdout straight through — no subscription needed.
  let releaseHeadlessOutputState = (): void => {};
  if (
    executionMode === EXECUTION_MODES.HEADLESS &&
    !options.quiet &&
    !options.json
  ) {
    // The script reporter emits a rich verdict and also sends the historical
    // one-line status message. Collapse the latter when its matching verdict
    // has already reached this terminal, while preserving unrelated statuses.
    const pendingScriptStatusMessages = new Map<string, number>();
    const parallelGroups = new Map<string, CliParallelGroupState>();
    const attempts = new Map<number, CliAttemptState>();
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

    releaseHeadlessOutputState = (): void => {
      if (released) {
        return;
      }
      released = true;
      for (const attempt of attempts.values()) {
        if (attempt.retried) {
          CliTerminalFormatter.renderAttemptGroupSummary(
            attempt.stepName,
            attempt.attemptCount,
            attempt.totalElapsed
          );
        }
      }
      attempts.clear();
      parallelGroups.clear();
      renderedFinalStepLabels.clear();
      pendingScriptStatusMessages.clear();
    };

    instance.onPromptStart((data) => {
      if (data.cliCommand !== undefined) {
        CliTerminalFormatter.renderPromptHeader(data);
        return;
      }

      const attempt = attempts.get(data.stepIndex) ?? {
        stepName: data.stepName,
        attemptCount: 0,
        totalElapsed: 0,
        retried: false,
        activeAttemptCompleted: false,
      };
      attempt.stepName = data.stepName;
      attempt.attemptCount = Math.max(
        attempt.attemptCount,
        data.attemptIndex + 1
      );
      attempt.retried ||= data.attemptIndex > 0;
      attempt.activeAttemptCompleted = false;
      attempts.set(data.stepIndex, attempt);

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
    });
    instance.onTargetScriptOutput((data) => {
      renderFinalStepLabel(data.target);
      const statusSummary = CliTerminalFormatter.getScriptVerdictStatusSummary(
        data.output
      );
      if (statusSummary) {
        pendingScriptStatusMessages.set(
          statusSummary,
          (pendingScriptStatusMessages.get(statusSummary) ?? 0) + 1
        );
      }
      CliTerminalFormatter.renderScriptOutput(data.output, {
        stepIndex:
          data.target.kind === FINAL_STEP_PHASES.QUEUE
            ? data.target.stepIndex
            : data.target.loopIndex,
        stepName: getCliOutputStepName(instance, data.target),
        key:
          data.target.kind === FINAL_STEP_PHASES.QUEUE
            ? `queue:${data.target.stepIndex}`
            : `final:${data.target.loopIndex}`,
      });
    });
    instance.onTargetStreamingEvents((data) => {
      renderFinalStepLabel(data.target);
      CliTerminalFormatter.renderEvents(data.events, {
        stepIndex:
          data.target.kind === FINAL_STEP_PHASES.QUEUE
            ? data.target.stepIndex
            : data.target.loopIndex,
        stepName: data.stepName,
        key:
          data.target.kind === FINAL_STEP_PHASES.QUEUE
            ? `queue:${data.target.stepIndex}`
            : `final:${data.target.loopIndex}`,
      } satisfies CliOutputTarget);
    });
    instance.onTargetStreamingChunk((data) => {
      renderFinalStepLabel(data.target);
      CliTerminalFormatter.renderStreamingChunk(data.chunk, {
        stepIndex:
          data.target.kind === FINAL_STEP_PHASES.QUEUE
            ? data.target.stepIndex
            : data.target.loopIndex,
        stepName: data.stepName,
        key:
          data.target.kind === FINAL_STEP_PHASES.QUEUE
            ? `queue:${data.target.stepIndex}`
            : `final:${data.target.loopIndex}`,
      } satisfies CliOutputTarget);
    });
    instance.onWorkflowStatusMessage((data) => {
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
    });
    instance.onPromptComplete((data) => {
      const attempt = attempts.get(data.stepIndex);
      if (attempt && !attempt.activeAttemptCompleted) {
        attempt.totalElapsed += data.elapsed ?? 0;
        attempt.activeAttemptCompleted = true;
      }
      const state = getParallelGroup(data.parallelGroupId);
      if (state?.started.has(data.stepIndex)) {
        if (!state.failed.has(data.stepIndex)) {
          state.completed.add(data.stepIndex);
          renderParallelGroupProgress(state);
        }
      }
      CliTerminalFormatter.flushStreamingBuffer({
        stepIndex: data.stepIndex,
        stepName: data.stepName,
      });
      CliTerminalFormatter.renderStats(data);
    });
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
    releaseHeadlessOutputState();
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
      }

      assertSecretGrantsApproved(
        instance.promptQueue.getWorkflowFile(),
        workingDir
      );

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

      // Only an explicit --harness overrides the workflow's own `harness`;
      // otherwise execution resolves it from the workflow, then settings.
      await instance.executeLoadedPromptFile(explicitHarness);
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

    releaseHeadlessOutputState();

    const state = instance.promptQueue.getState();
    const schemaRefusal = runStateRefusals.first();
    const exitCode = applyRunStateRefusal(getExitCode(state), schemaRefusal);
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
          instance.promptQueue.getWorkflowFile(),
          explicitHarness,
          harness,
          config.model
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
    }
    if (!completed && schemaRefusal) {
      // stderr in every mode: `--json` stdout stays one JSON document.
      console.error(chalk.red("Error: " + schemaRefusal.message));
    }

    process.exit(exitCode);
  } catch (err) {
    releaseHeadlessOutputState();
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      const state = instance.getQueueState();
      const result = buildCliJsonResult({
        state: undefined,
        promptFile: instance.promptQueue.getWorkflowFile(),
        ...resolveCliRunHarnessAndModel(
          instance.promptQueue.getWorkflowFile(),
          explicitHarness,
          harness,
          config.model
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

function handleHistoryCommand(operation: Promise<void>): Promise<void> {
  return operation.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(2);
  });
}

function createHistoryInspectionCommandIo(): HistoryInspectionCommandIo {
  return {
    writeOut: (message) => console.log(message),
    writeErr: (message) => console.error(message),
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
    const workflow = options.prompt
      ? { steps: [{ prompt: options.prompt }] }
      : await parser.parsePromptFile(resolvedFile!);
    if (!workflow) {
      throw new Error(`Failed to load workflow file: ${resolvedFile}`);
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

    const previewWorkflow = applyDryRunSessionOverrides(workflow, config);
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
      modelsByHarness: {
        ...defaultsContext.defaults.modelsByHarness,
        ...(config.model ? { [harness]: config.model } : {}),
      },
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

function applyDryRunSessionOverrides(
  workflow: PromptFile,
  config: ResolvedCliConfig
): PromptFile {
  const steps = (workflow.steps ?? []).map((step) => ({ ...step }));
  if (config.sessionId && steps.length > 0) {
    const firstStep = steps[0];
    if (!isScriptStep(firstStep)) {
      firstStep.sessionId = config.sessionId;
      firstStep.resumeSession = true;
    }
  } else if (config.resumeSession === false) {
    for (const step of steps) {
      if (!isScriptStep(step)) {
        delete step.sessionId;
        step.resumeSession = false;
      }
    }
  } else if (config.resumeSession === true) {
    for (const step of steps) {
      if (!isScriptStep(step)) {
        step.resumeSession = true;
      }
    }
  }
  return { ...workflow, steps };
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
  const workflowKey = operation.workflow;
  WorkflowPaths.assertValidWorkflowKey(workflowKey);
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
      {
        ...(options.harness ? { harness: options.harness as HarnessId } : {}),
        ...(options.model ? { model: options.model } : {}),
      },
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
      options.harness as HarnessId | undefined,
      warnIfNeeded
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
    lineageRepository
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
      lineageRepository,
      target.allowInterruptedRun
    );
    await instance.executeContinuationAtRun(
      workflowKey,
      runRef,
      appended.definitionRevision,
      warnIfNeeded
    );
    return;
  }

  await instance.executeContinuationAtRun(
    workflowKey,
    runRef,
    target.definitionRevision,
    warnIfNeeded
  );
}

async function parseAppendTail(
  operation: Extract<CliRunOperation, { kind: "append" }>,
  options: AppendOptions,
  platform: CliAdapter,
  userFeedbackSink: ConsoleUserFeedbackSink
): Promise<WorkflowStep[]> {
  if (options.prompt) {
    return [{ prompt: options.prompt }];
  }
  if (!operation.file) {
    throw new Error("Append source was not provided");
  }
  const parser = new PromptFileParser(platform, userFeedbackSink);
  const parsed = await parser.parsePromptFile(path.resolve(operation.file));
  if (!parsed?.steps?.length) {
    throw new Error("Append source must contain at least one workflow step");
  }
  return parsed.steps;
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
  lineageRepository: WorkflowLineageRepository
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
    "continue",
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
  const resolvedFile = path.resolve(file);
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
    const { PromptFileParser } = await import("./core/PromptFileParser");
    const parser = new PromptFileParser();
    const result = await parser.parsePromptFile(resolvedFile);
    if (!result) {
      const message = `${path.basename(resolvedFile)} failed validation`;
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
    const validationAdapter = new CliAdapter({
      harness: HARNESS_IDS.COPILOT_CLI,
      cwd: workingDir,

      vars: {},
      verbose: false,
      quiet: true,
      json: options.json === true,
      cliExecutionMode: EXECUTION_MODES.HEADLESS,
    });
    configService.setUserBackend(createUserConfigBackend());
    configService.setWorkspaceBackend(createWorkspaceConfigBackend(workingDir));
    configService.setCliOverlay({});
    registerCliAdapter(validationAdapter);

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

function getHarnessDisplayName(harnessId: HarnessId): string {
  return HARNESS_INFO[harnessId]?.name ?? harnessId;
}

/** Ask a y/N question on stderr (keeps stdout pipe-friendly). */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();
  return answer.toLowerCase().startsWith("y");
}

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
  const resolvedFile = path.resolve(workingDir, file);
  Log.initializeCli(workingDir, false);

  const userBackend = createUserConfigBackend();
  const workspaceBackend = createWorkspaceConfigBackend(workingDir);
  configService.setUserBackend(userBackend);
  configService.setWorkspaceBackend(workspaceBackend);

  const workflow = await new PromptFileParser().parsePromptFile(resolvedFile);
  if (!workflow) {
    console.error(
      chalk.red(`Error: Failed to load workflow file: ${resolvedFile}`)
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

  const { CommitMessageGenerationError, CommitMessageGenerator } =
    await import("./git/CommitMessageGenerator");
  const generator = new CommitMessageGenerator(
    undefined,
    cliRunnerHostIdentity
  );

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

  if (!diffResult.staged) {
    console.error(
      chalk.yellow(
        "Note: Generated from unstaged changes. Stage files before committing."
      )
    );
    console.error();
  }

  if (!options.yes) {
    const confirmed = await promptYesNo("Commit with this message? [y/N] ");
    if (!confirmed) {
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
