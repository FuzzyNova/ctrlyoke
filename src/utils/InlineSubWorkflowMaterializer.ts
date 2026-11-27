import type {
  InlineSubWorkflowDefinition,
  PromptFile,
  SubWorkflowStep,
} from "../types/CtrlYokeTypes";
import {
  PRIOR_CONTEXT_KEYWORDS,
  PROMPT_PROPERTIES,
  STEP_TYPES,
} from "../types/DashboardConstants";

const INHERITED_PROPERTIES = [
  "harness",
  "model",
  "executionMode",
  "agent",
  "skills",
  "mcpServers",
  "hooks",
  "secrets",
  "additionalArgs",
  "toolPermissions",
  "errorBehavior",
  "endCondition",
  "preCondition",
] as const satisfies readonly (keyof PromptFile)[];

/** Build the self-contained, child-run definition for an inline workflow step. */
export function materializeInlineSubWorkflow(
  parent: PromptFile,
  effectiveVars: Readonly<Record<string, string>>,
  effectiveTrustedExternalRoots: readonly string[],
  step: SubWorkflowStep,
  stepNumber: number,
  parentName?: string
): { definition: PromptFile; displayName: string } {
  if (typeof step.workflow === "string") {
    throw new Error("Cannot materialize a file-backed sub-workflow");
  }
  const inline = step.workflow as InlineSubWorkflowDefinition;
  const definition: PromptFile = {
    steps: [inline],
    vars: { ...effectiveVars },
  };
  const parentRecord = parent as Record<string, unknown>;
  const childRecord = definition as Record<string, unknown>;
  for (const key of INHERITED_PROPERTIES) {
    if (parentRecord[key] !== undefined) childRecord[key] = parentRecord[key];
  }
  definition.trustedExternalRoots = [...effectiveTrustedExternalRoots];
  if (parent.maxSteps !== undefined) definition.maxSteps = parent.maxSteps;
  // Relative selectors and resume state address the parent run. A child starts
  // a fresh run, while a run-addressed priorContext remains valid.
  delete childRecord.resumeSession;
  if (
    childRecord.priorContext === PRIOR_CONTEXT_KEYWORDS.ALL ||
    childRecord.priorContext === PRIOR_CONTEXT_KEYWORDS.PREVIOUS ||
    childRecord.priorContext === PRIOR_CONTEXT_KEYWORDS.NONE ||
    Array.isArray(childRecord.priorContext) ||
    (childRecord.priorContext &&
      typeof childRecord.priorContext === "object" &&
      "previous" in childRecord.priorContext)
  )
    delete childRecord.priorContext;

  // Step properties take precedence over inherited workflow defaults.
  const inlineRecord = inline as unknown as Record<string, unknown>;
  if (inline.worktree !== undefined) definition.worktree = inline.worktree;
  for (const key of Object.keys(inlineRecord)) {
    if (
      key !== "type" &&
      key !== PROMPT_PROPERTIES.PROMPT &&
      key !== STEP_TYPES.SCRIPT &&
      key !== PROMPT_PROPERTIES.NAME &&
      key !== "worktree"
    ) {
      childRecord[key] = inlineRecord[key];
    }
  }
  const workflowName = parentName?.trim() || parent.name?.trim() || "Workflow";
  const displayName =
    step.name?.trim() || `${workflowName} · step ${stepNumber}`;
  definition.name = displayName;
  return { definition, displayName };
}
