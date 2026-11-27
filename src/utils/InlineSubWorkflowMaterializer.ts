import {
  EXECUTION_PROPERTY_KEYS,
  isPriorContextRunSource,
  type ExecutionProperties,
  type InlineSubWorkflowDefinition,
  type PromptFile,
  type SubWorkflowStep,
  type WorkflowStep,
} from "../types/CtrlYokeTypes";
import { PROMPT_PROPERTIES } from "../types/DashboardConstants";
import {
  VarSubstitutionValidationError,
  VarSubstitutor,
} from "./VarSubstitutor";
import { VAR_SUBSTITUTION_PHASES } from "./VarSubstitutionPolicy";

/**
 * Workflow-level execution properties a parent's root never hands to an inline
 * child, because each one addresses the parent run rather than the child's:
 *
 * - `sessionId`: a number or `finalStep` selects a session of the parent run,
 *   and an exact CLI session ID would resume the parent's conversation in what
 *   is meant to be a fresh run.
 * - `resumeSession`: the inline step is the first step of a new run, so there
 *   is no earlier step of the child to resume; inheriting it would only carry
 *   the parent's intent across the boundary.
 * - `priorContext`: `all`, `previous`, `{ previous: N }`, numeric arrays and
 *   the final-step keywords select earlier steps of the parent run. Only the
 *   run-address form (`{ workflow, run }`) means the same thing in the child,
 *   so it is the one form that is inherited.
 */
const RUN_SCOPED_EXECUTION_KEYS = new Set<keyof ExecutionProperties>([
  PROMPT_PROPERTIES.SESSION_ID,
  PROMPT_PROPERTIES.RESUME_SESSION,
  PROMPT_PROPERTIES.PRIOR_CONTEXT,
]);

/** Execution properties an inline child inherits from its parent's root. */
export const INLINE_INHERITED_EXECUTION_KEYS = EXECUTION_PROPERTY_KEYS.filter(
  (key) => !RUN_SCOPED_EXECUTION_KEYS.has(key)
);

/**
 * The dispatch-substituted `name` an inline child is named from (pass it to
 * {@link materializeInlineSubWorkflow}). When the step does not substitute,
 * the authored `{{…}}` text is never a name: the empty string makes the
 * child take the default label, as a name that substitutes to nothing does.
 * (The executor substitutes the whole step before launching and fails it on
 * the same error, so this fallback only guards callers that name first.)
 */
export function substituteInlineStepName(
  step: SubWorkflowStep,
  vars: Readonly<Record<string, string>>,
  viewIndex: number
): string | undefined {
  try {
    return VarSubstitutor.substituteStepView(
      step,
      vars,
      VAR_SUBSTITUTION_PHASES.DISPATCH,
      viewIndex
    ).name;
  } catch (error) {
    if (!(error instanceof VarSubstitutionValidationError)) throw error;
    return "";
  }
}

/** Where the inline step sits in the parent, for its default lineage name. */
export interface InlineSubWorkflowPosition {
  /** Lineage name used when the step has no `name`, e.g. "step 2". */
  readonly label: string;
}

/**
 * Build the self-contained child-run definition for an inline workflow step.
 *
 * `parent` must be the parent's authored definition, not its run-start
 * resolved copy: the child substitutes its own fields with `effectiveVars`, so
 * materializing from resolved values would substitute them twice. The inline
 * step's own keys stay on the child's single step, so they override the
 * inherited root exactly as a step's keys override its workflow; only
 * `worktree`, a workflow-only key, moves to the child's root.
 */
export function materializeInlineSubWorkflow(
  parent: PromptFile,
  effectiveVars: Readonly<Record<string, string>>,
  step: SubWorkflowStep,
  position: InlineSubWorkflowPosition,
  parentName?: string,
  substitutedStepName?: string
): { definition: PromptFile; displayName: string } {
  if (typeof step.workflow === "string") {
    throw new Error("Cannot materialize a file-backed sub-workflow");
  }
  const { worktree, ...childStep } =
    step.workflow as InlineSubWorkflowDefinition;
  const definition: PromptFile = {
    steps: [childStep as WorkflowStep],
    vars: { ...effectiveVars },
  };
  const childRoot = definition as Record<string, unknown>;
  const parentRoot = parent as Record<string, unknown>;
  for (const key of INLINE_INHERITED_EXECUTION_KEYS) {
    if (parentRoot[key] !== undefined) childRoot[key] = parentRoot[key];
  }
  if (isPriorContextRunSource(parent.priorContext)) {
    definition.priorContext = parent.priorContext;
  }
  // The declared set, null included, is inherited as authored. The child's
  // trust approvals are keyed to the parent's definition file, so it resolves
  // the same effective set the parent does.
  if (parent.trustedExternalRoots !== undefined) {
    definition.trustedExternalRoots =
      parent.trustedExternalRoots === null
        ? null
        : [...parent.trustedExternalRoots];
  }
  if (parent.maxSteps !== undefined) definition.maxSteps = parent.maxSteps;
  if (worktree !== undefined) definition.worktree = worktree;

  const workflowName = parentName?.trim() || parent.name?.trim() || "Workflow";
  // `steps[].name` substitutes at dispatch, so the caller passes the step's
  // dispatch-substituted name. A name that substitutes to nothing falls back
  // to the default label, never to the authored `{{…}}` text.
  const stepName =
    substitutedStepName !== undefined ? substitutedStepName : step.name;
  const displayName = stepName?.trim() || `${workflowName} · ${position.label}`;
  definition.name = displayName;
  return { definition, displayName };
}
