import {
  assertNever,
  getStepType,
  isPromptStep,
  type ManagedWorktreeConfig,
  type PromptStep,
  type SubWorkflowStep,
  type WorkflowStep,
  type WorkingFile,
} from "../types/CtrlYokeTypes";
import { STEP_TYPES, WORKTREE_MODES } from "../types/DashboardConstants";
import {
  MCP_WORKFLOW_STATUS_TOOL_NAME,
  type McpWorktreePresetSummary,
  type McpWorktreePresetUse,
} from "./McpToolDefinitions";
import { formatDeclaredPresetList, getDeclaredPreset } from "./McpNamedPresets";
import {
  promptFirstLinePreview,
  STEP_LISTING_PROMPT_PREVIEW_MAX_CHARS,
} from "./TextUtils";

/** Refusal for a `worktree` reference on a workflow that declares no presets. */
export const MCP_NO_WORKTREE_PRESETS_MESSAGE =
  "This workflow defines no worktree presets, so steps can't be queued in their own worktree";

function hasWorktreePresets(workingFile: WorkingFile): boolean {
  return Object.keys(workingFile.worktreePresets ?? {}).length > 0;
}

/**
 * Describe every worktree preset the workflow declares, in declaration order.
 * An empty list tells the caller lanes are unavailable.
 */
export function summarizeMcpWorktreePresets(
  workingFile: WorkingFile
): McpWorktreePresetSummary[] {
  return Object.entries(workingFile.worktreePresets ?? {}).map(
    ([name, preset]) => ({
      name,
      merge: preset.merge === true,
      setup: promptFirstLinePreview(
        preset.setup ?? "",
        STEP_LISTING_PROMPT_PREVIEW_MAX_CHARS
      ),
    })
  );
}

/**
 * Resolve an MCP worktree preset reference into a copy of the declared
 * preset. The copy is by value, so later edits to the preset never change a
 * lane that was already queued.
 */
export function materializeMcpWorktreePreset(
  workingFile: WorkingFile,
  reference: McpWorktreePresetUse
): ManagedWorktreeConfig {
  if (!hasWorktreePresets(workingFile)) {
    throw new Error(`worktree: ${MCP_NO_WORKTREE_PRESETS_MESSAGE}.`);
  }
  const preset = getDeclaredPreset(workingFile.worktreePresets, reference.use);
  if (!preset) {
    throw new Error(
      `worktree: unknown worktree preset '${reference.use}'. Available presets: ${formatDeclaredPresetList(workingFile.worktreePresets)}. ${MCP_WORKFLOW_STATUS_TOOL_NAME} lists each preset under metadata.worktreePresets.`
    );
  }
  return structuredClone(preset);
}

/**
 * Fields a lane keeps on its `type: workflow` wrapper rather than inside its
 * inline prompt step: the display fields, which name and show the child, and
 * the queue slot's runtime.
 */
const LANE_WRAPPER_FIELDS = ["name", "enabled", "color", "_runtime"] as const;

/**
 * Wrap a materialized prompt step into a lane: a `type: workflow` step whose
 * inline definition is the prompt step plus the preset's worktree (D13/D14).
 * The display fields and runtime move to the wrapper; the name also names the
 * child run.
 */
export function wrapPromptStepAsLane(
  step: PromptStep,
  worktree: ManagedWorktreeConfig
): SubWorkflowStep {
  const { name, enabled, color, _runtime, ...promptFields } = step;
  return {
    type: STEP_TYPES.WORKFLOW,
    ...(name === undefined ? {} : { name }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(color === undefined ? {} : { color }),
    workflow: { ...promptFields, worktree },
    ...(_runtime === undefined ? {} : { _runtime }),
  } as SubWorkflowStep;
}

/** A lane as `wrapPromptStepAsLane` builds it, taken apart again. */
export interface AgentLaneParts {
  /** The lane as a plain prompt step, display fields and runtime included. */
  readonly promptStep: PromptStep;
  /** The lane's by-value preset copy. */
  readonly worktree: ManagedWorktreeConfig;
}

/**
 * Take apart a step that has exactly the shape `wrapPromptStepAsLane` builds:
 * a `type: workflow` wrapper holding only display fields and runtime, around
 * an inline prompt step with a managed `worktree` and no name of its own. Any
 * other workflow step (a file reference, an inline script, `onFail`, a named
 * or `false` worktree, or none) is not an agent lane, and MCP cannot edit it.
 */
export function agentLaneParts(step: WorkflowStep): AgentLaneParts | undefined {
  if (getStepType(step) !== STEP_TYPES.WORKFLOW) return undefined;
  const wrapper = step as SubWorkflowStep;
  const wrapperFields = new Set<string>([
    "type",
    "workflow",
    ...LANE_WRAPPER_FIELDS,
  ]);
  if (Object.keys(wrapper).some((key) => !wrapperFields.has(key))) {
    return undefined;
  }
  const inline = wrapper.workflow;
  if (typeof inline === "string" || !isPromptStep(inline)) return undefined;
  const { worktree, ...promptFields } = inline;
  if (
    worktree === undefined ||
    typeof worktree !== "object" ||
    worktree.mode !== WORKTREE_MODES.MANAGED ||
    Object.prototype.hasOwnProperty.call(promptFields, "name")
  ) {
    return undefined;
  }
  const { name, enabled, color, _runtime } = wrapper;
  return {
    promptStep: {
      ...(name === undefined ? {} : { name }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(color === undefined ? {} : { color }),
      ...promptFields,
      ...(_runtime === undefined ? {} : { _runtime }),
    } as PromptStep,
    worktree: worktree as ManagedWorktreeConfig,
  };
}

/**
 * The prompt step a queued step runs: the step itself, or the inline prompt
 * step of a lane. Its execution properties resolve against the same workflow
 * defaults either way, because an inline child inherits the parent's root.
 */
export function laneOrPromptStep(step: WorkflowStep): PromptStep | undefined {
  const stepType = getStepType(step);
  switch (stepType) {
    case STEP_TYPES.PROMPT:
      return step as PromptStep;
    case STEP_TYPES.SCRIPT:
      return undefined;
    case STEP_TYPES.WORKFLOW: {
      const inline = (step as SubWorkflowStep).workflow;
      if (typeof inline === "string" || !isPromptStep(inline)) return undefined;
      const { worktree: _worktree, ...promptFields } = inline;
      return promptFields as PromptStep;
    }
    default:
      return assertNever(stepType);
  }
}
