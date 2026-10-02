import { parseCliPromptFile } from "./CliPromptFile";
import { resolveCliFileArgument } from "./CliFileArgument";
import { RunContinuationService } from "../core/orchestration/RunContinuationService";
import { WorkflowLineageRepository } from "../core/orchestration/WorkflowLineageRepository";
import { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import type {
  RunRef,
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import { RUNNER_IDS } from "../types/DashboardConstants";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import {
  resolveCliRunRefAtLineage,
  type CliRunSummaryProvider,
} from "./CliRunSelector";
import type {
  StepEditOptions,
  StepRemoveOptions,
  StepReorderOptions,
} from "./StepCommandDefinitions";

export const CLI_STEP_MUTATION_JSON_SCHEMA_VERSION = 1 as const;

const STEP_MUTATION_OPERATIONS = {
  EDIT: "edit",
  REMOVE: "remove",
  REORDER: "reorder",
} as const;

export interface StepCommandIo {
  writeOut(message: string): void;
}

export interface StepCommandContext {
  workspaceRoot: string;
  outputHistoryManager: CliRunSummaryProvider;
  lineageRepository: WorkflowLineageRepository;
  observer: RunnerHostIdentity;
  parseStepFile(file: string): Promise<WorkflowStep[]>;
}

interface StepMutationJsonResult {
  schemaVersion: typeof CLI_STEP_MUTATION_JSON_SCHEMA_VERSION;
  success: true;
  operation: (typeof STEP_MUTATION_OPERATIONS)[keyof typeof STEP_MUTATION_OPERATIONS];
  workflowKey: WorkflowKey;
  runRef: RunRef;
  definitionRevision: number;
  descriptorRevision: number;
  stepCount: number;
  index?: number;
  order?: number[];
}

export async function editStepCommand(
  file: string | undefined,
  options: StepEditOptions,
  context: StepCommandContext,
  io: StepCommandIo
): Promise<void> {
  const index = parseStepIndex(options.index);
  const change = await parseStepChange(file, options.prompt, context);
  const target = await resolveEditTarget(
    options.workflow,
    options.run,
    context
  );
  const edited = await RunContinuationService.editStepAtRun(
    context.workspaceRoot,
    target.workflowKey,
    target.runRef,
    index,
    change,
    target.definitionRevision,
    context.lineageRepository,
    target.allowInterruptedRun
  );

  writeMutationResult(
    io,
    options.json === true,
    {
      schemaVersion: CLI_STEP_MUTATION_JSON_SCHEMA_VERSION,
      success: true,
      operation: STEP_MUTATION_OPERATIONS.EDIT,
      workflowKey: target.workflowKey,
      runRef: target.runRef,
      definitionRevision: edited.definitionRevision,
      descriptorRevision: edited.descriptorRevision,
      stepCount: edited.workingFile.steps?.length ?? 0,
      index,
    },
    `Edited step ${index} in ${target.workflowKey}/${target.runRef} (definition revision ${edited.definitionRevision}).`
  );
}

export async function removeStepCommand(
  options: StepRemoveOptions,
  context: StepCommandContext,
  io: StepCommandIo
): Promise<void> {
  const index = parseStepIndex(options.index);
  const target = await resolveEditTarget(
    options.workflow,
    options.run,
    context
  );
  const removed = await RunContinuationService.removeStepAtRun(
    context.workspaceRoot,
    target.workflowKey,
    target.runRef,
    index,
    target.definitionRevision,
    context.lineageRepository,
    target.allowInterruptedRun
  );

  writeMutationResult(
    io,
    options.json === true,
    {
      schemaVersion: CLI_STEP_MUTATION_JSON_SCHEMA_VERSION,
      success: true,
      operation: STEP_MUTATION_OPERATIONS.REMOVE,
      workflowKey: target.workflowKey,
      runRef: target.runRef,
      definitionRevision: removed.definitionRevision,
      descriptorRevision: removed.descriptorRevision,
      stepCount: removed.workingFile.steps?.length ?? 0,
      index,
    },
    `Removed step ${index} from ${target.workflowKey}/${target.runRef} (definition revision ${removed.definitionRevision}).`
  );
}

export async function reorderStepsCommand(
  options: StepReorderOptions,
  context: StepCommandContext,
  io: StepCommandIo
): Promise<void> {
  const order = parseStepOrder(options.order);
  const target = await resolveEditTarget(
    options.workflow,
    options.run,
    context
  );
  const reordered = await RunContinuationService.reorderStepsAtRun(
    context.workspaceRoot,
    target.workflowKey,
    target.runRef,
    order,
    target.definitionRevision,
    context.lineageRepository,
    undefined,
    target.allowInterruptedRun
  );

  writeMutationResult(
    io,
    options.json === true,
    {
      schemaVersion: CLI_STEP_MUTATION_JSON_SCHEMA_VERSION,
      success: true,
      operation: STEP_MUTATION_OPERATIONS.REORDER,
      workflowKey: target.workflowKey,
      runRef: target.runRef,
      definitionRevision: reordered.definitionRevision,
      descriptorRevision: reordered.descriptorRevision,
      stepCount: reordered.workingFile.steps?.length ?? 0,
      order,
    },
    `Reordered pending steps in ${target.workflowKey}/${target.runRef} (definition revision ${reordered.definitionRevision}).`
  );
}

async function resolveEditTarget(
  workflow: string,
  selector: string,
  context: StepCommandContext
): Promise<{
  workflowKey: WorkflowKey;
  runRef: RunRef;
  definitionRevision: number;
  allowInterruptedRun: boolean;
}> {
  WorkflowPaths.assertValidWorkflowKey(workflow);
  const workflowKey = workflow as WorkflowKey;
  const runRef = await resolveCliRunRefAtLineage(
    context.workspaceRoot,
    context.outputHistoryManager,
    workflowKey,
    selector,
    "--run"
  );
  const target = await RunContinuationService.validateContinuationTarget(
    context.workspaceRoot,
    workflowKey,
    runRef,
    context.lineageRepository,
    "edit",
    true,
    context.observer
  );
  return { workflowKey, runRef, ...target };
}

async function parseStepChange(
  file: string | undefined,
  prompt: string | undefined,
  context: StepCommandContext
): Promise<{ updates: Partial<WorkflowStep> }> {
  if (file !== undefined && prompt !== undefined) {
    throw new Error("--prompt cannot be used together with a file argument");
  }
  if (prompt !== undefined) {
    return { updates: { prompt } };
  }
  if (file === undefined) {
    throw new Error("Provide a file argument or --prompt <text>");
  }

  const steps = await context.parseStepFile(resolveCliFileArgument(file));
  if (steps.length !== 1) {
    throw new Error("Edit source must contain exactly one workflow step");
  }
  return { updates: steps[0] };
}

function parseStepIndex(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid step index "${value}"; expected a non-negative integer`
    );
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index)) {
    throw new Error(`Invalid step index "${value}"; expected a safe integer`);
  }
  return index;
}

function parseStepOrder(value: string): number[] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(
      `Invalid step order "${value}"; expected comma-separated non-negative integers`
    );
  }
  return parts.map((part) => parseStepIndex(part));
}

function writeMutationResult(
  io: StepCommandIo,
  json: boolean,
  result: StepMutationJsonResult,
  message: string
): void {
  io.writeOut(json ? JSON.stringify(result) : message);
}

/** Build the default Node-only context used by the standalone CLI. */
export function createStepCommandContext(
  workspaceRoot: string,
  observer: RunnerHostIdentity = {
    runner: RUNNER_IDS.CLI,
    hostInstanceId: "cli-step-command",
    pid: process.pid,
  }
): StepCommandContext {
  return {
    workspaceRoot,
    outputHistoryManager: new OutputHistoryManager(workspaceRoot),
    lineageRepository: new WorkflowLineageRepository(),
    observer,
    parseStepFile: async (file) => {
      const parsed = await parseCliPromptFile(file);
      return parsed.steps ?? [];
    },
  };
}
