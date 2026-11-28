import { CONDITION_ACTIONS, STEP_TYPES } from "@root/types/DashboardConstants";
import {
  assertNever,
  getStepType,
  getWorkflowStepText,
  type InlineSubWorkflowDefinition,
  type InlineSubWorkflowStepKind,
  type PromptStep,
  type SubWorkflowStep,
  type WorktreeConfig,
} from "@root/types/CtrlYokeTypes";
import type { PropertyValues } from "@store/editorStore";
import { buildPropertyUpdateValues } from "./promptPropertyValues";
import {
  getScriptStepEditorValues,
  getScriptStepPropertyUpdate,
} from "./scriptStepProperties";
import { stepEnabledPatch, type StepEnabledValue } from "./wholeValueVariables";

/** The step editor's Workflow-mode values for a sub-workflow step. */
export interface SubWorkflowStepEditorValues {
  /** A workflow file path, or the inline definition the editor built. */
  workflow: string | InlineSubWorkflowDefinition;
  onFail: string;
  color: SubWorkflowStep["color"];
  enabled: StepEnabledValue;
  promptName: string;
}

export interface SubWorkflowStepPropertyUpdate {
  /**
   * The message's `text`: the workflow path, or the inline step's prompt or
   * script (an inline definition itself travels as `properties.workflow`).
   */
  text: string;
  properties: Record<string, unknown>;
  clearProperties: string[];
}

/**
 * Display fields an inline definition's wrapped step may carry on its own.
 * The editor header edits the outer step's name, colour and enabled state,
 * so the inline form leaves the wrapped step's copies as authored.
 */
const INLINE_PRESERVED_FIELDS = ["name", "enabled", "color"] as const;

/**
 * The editor's hold on an inline definition (D13). The wrapped step's own
 * fields live in the editor's prompt or script fields, so the inline form
 * reuses those editors; this keeps only what they do not hold.
 */
export interface InlineSubWorkflowEditorShell {
  /** The kind of step the definition wraps. */
  kind: InlineSubWorkflowStepKind;
  /** The child's `worktree`; undefined runs it in the parent's checkout. */
  worktree: WorktreeConfig | undefined;
  /** The wrapped step's own display fields and explicit `type`, as authored. */
  preserved: Record<string, unknown>;
}

/** The kind a freshly chosen Inline form wraps. */
export const DEFAULT_INLINE_SUB_WORKFLOW_KIND: InlineSubWorkflowStepKind =
  STEP_TYPES.PROMPT;

/** Start an inline shell for `kind`, carrying `worktree` over. */
export function createInlineSubWorkflowShell(
  kind: InlineSubWorkflowStepKind = DEFAULT_INLINE_SUB_WORKFLOW_KIND,
  worktree: WorktreeConfig | undefined = undefined
): InlineSubWorkflowEditorShell {
  return { kind, worktree, preserved: {} };
}

/**
 * Whether `shell` holds anything a fresh Inline form does not: another
 * wrapped kind, a worktree, or preserved fields. A new-step draft holding
 * such a shell is dirty even with empty prompt and script text.
 */
export function isInlineSubWorkflowShellEdited(
  shell: InlineSubWorkflowEditorShell | null
): boolean {
  return (
    shell !== null &&
    (shell.kind !== DEFAULT_INLINE_SUB_WORKFLOW_KIND ||
      shell.worktree !== undefined ||
      Object.keys(shell.preserved).length > 0)
  );
}

/** The kind an inline definition wraps. */
export function getInlineSubWorkflowStepKind(
  definition: InlineSubWorkflowDefinition
): InlineSubWorkflowStepKind {
  const kind = getStepType(definition);
  switch (kind) {
    case STEP_TYPES.PROMPT:
    case STEP_TYPES.SCRIPT:
      return kind;
    case STEP_TYPES.WORKFLOW:
      throw new Error(
        "An inline workflow definition cannot wrap a workflow step"
      );
    default:
      return assertNever(kind);
  }
}

/**
 * Split an inline definition into the wrapped step the prompt or script
 * editor loads and the shell the inline form keeps.
 */
export function splitInlineSubWorkflowDefinition(
  definition: InlineSubWorkflowDefinition
): {
  wrapped: InlineSubWorkflowDefinition;
  shell: InlineSubWorkflowEditorShell;
} {
  const { worktree, ...wrapped } = definition;
  const kind = getInlineSubWorkflowStepKind(definition);
  const preserved: Record<string, unknown> = {};
  for (const field of INLINE_PRESERVED_FIELDS) {
    if (field in wrapped) preserved[field] = wrapped[field];
  }
  // A script's `type` is rebuilt with it; a prompt's is optional, so keep
  // whether it was written.
  if (kind === STEP_TYPES.PROMPT && wrapped.type === STEP_TYPES.PROMPT) {
    preserved.type = STEP_TYPES.PROMPT;
  }
  return {
    wrapped: wrapped as InlineSubWorkflowDefinition,
    shell: { kind, worktree, preserved },
  };
}

/**
 * The editor fields an inline definition is built from: the shell plus the
 * prompt or script fields its wrapped step is edited in. `EditorState`
 * satisfies it, so callers pass the store's state.
 */
export interface SubWorkflowEditorContent {
  subWorkflowPath: string;
  subWorkflowInline: InlineSubWorkflowEditorShell | null;
  subWorkflowOnFail: string;
  promptText: string;
  promptName: string;
  stepEnabled: StepEnabledValue;
  properties: PropertyValues;
  scriptCommand: string;
  scriptTimeoutSec: number | undefined;
  scriptOnPass: string;
  scriptOnFail: string;
  scriptCompareSource: string;
  scriptOperator: string;
  scriptExpected: string;
  scriptIgnoreCase: boolean;
  scriptEnv: Record<string, string> | undefined;
  scriptExecutionMode: PromptStep["executionMode"];
  scriptShell: string | undefined;
}

/**
 * Build the inline definition the editor holds: the wrapped step from the
 * prompt or script fields (its display fields are the outer step's, so they
 * are not written inside), the shell's preserved fields, and `worktree`.
 */
export function buildInlineSubWorkflowDefinition(
  editor: SubWorkflowEditorContent,
  shell: InlineSubWorkflowEditorShell
): InlineSubWorkflowDefinition {
  const worktree =
    shell.worktree !== undefined ? { worktree: shell.worktree } : {};
  switch (shell.kind) {
    case STEP_TYPES.PROMPT: {
      const { properties } = buildPropertyUpdateValues(
        { ...editor.properties, color: undefined },
        { promptText: editor.promptText }
      );
      return {
        ...shell.preserved,
        prompt: editor.promptText,
        ...properties,
        ...worktree,
      } as InlineSubWorkflowDefinition;
    }
    case STEP_TYPES.SCRIPT: {
      const { properties } = getScriptStepPropertyUpdate({
        ...getScriptStepEditorValues(editor),
        color: undefined,
        enabled: true,
        promptName: "",
      });
      return {
        ...shell.preserved,
        ...properties,
        script: editor.scriptCommand,
        ...worktree,
      } as InlineSubWorkflowDefinition;
    }
    default:
      return assertNever(shell.kind);
  }
}

/**
 * Build a sub-workflow step's property update, shared by the editor's
 * save/dispatch paths and the execution preview. A path travels as the
 * message's `text`, like a script's command; an inline definition travels
 * whole as `properties.workflow`, so a save replaces it rather than merging
 * into the one on disk.
 *
 * A same-kind save merges the step's own fields over the step on disk, so a
 * field reset to its default is named in `clearProperties` rather than
 * omitted.
 */
export function getSubWorkflowStepPropertyUpdate(
  editor: SubWorkflowStepEditorValues
): SubWorkflowStepPropertyUpdate {
  const inline =
    typeof editor.workflow === "string" ? undefined : editor.workflow;
  const properties: Record<string, unknown> = {
    type: STEP_TYPES.WORKFLOW,
    ...(inline ? { workflow: inline } : {}),
    ...(editor.onFail !== CONDITION_ACTIONS.STOP_WORKFLOW
      ? { onFail: editor.onFail as SubWorkflowStep["onFail"] }
      : {}),
    ...(editor.color !== undefined ? { color: editor.color } : {}),
    ...stepEnabledPatch(editor.enabled),
  };

  const clearProperties = [
    ...(editor.onFail === CONDITION_ACTIONS.STOP_WORKFLOW ? ["onFail"] : []),
    ...(editor.color === undefined ? ["color"] : []),
    ...(editor.enabled === true ? ["enabled"] : []),
    ...(!editor.promptName.trim() ? ["name"] : []),
  ];

  const text = (
    typeof editor.workflow === "string"
      ? editor.workflow
      : getWorkflowStepText({
          type: STEP_TYPES.WORKFLOW,
          workflow: editor.workflow,
        })
  ).trim();

  return { text, properties, clearProperties };
}

/** The `workflow` value the editor holds: its path, or its inline definition. */
export function getSubWorkflowEditorWorkflow(
  editor: SubWorkflowEditorContent
): string | InlineSubWorkflowDefinition {
  return editor.subWorkflowInline === null
    ? editor.subWorkflowPath
    : buildInlineSubWorkflowDefinition(editor, editor.subWorkflowInline);
}

/**
 * The Workflow-mode property update for the editor's current content: the
 * one call every save, dispatch and preview path makes.
 */
export function getSubWorkflowStepUpdateFromEditor(
  editor: SubWorkflowEditorContent
): SubWorkflowStepPropertyUpdate {
  return getSubWorkflowStepPropertyUpdate({
    workflow: getSubWorkflowEditorWorkflow(editor),
    onFail: editor.subWorkflowOnFail,
    color: editor.properties.color,
    enabled: editor.stepEnabled,
    promptName: editor.promptName,
  });
}
