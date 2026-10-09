import {
  CTRLYOKE_FILE_KINDS,
  END_CONDITION_PROPERTIES,
  PROMPT_DIAGNOSTIC_FIELDS,
  PROMPT_PROPERTIES,
  type CtrlYokeFileKind,
  type PromptDiagnosticField,
} from "../types/DashboardConstants";
import {
  getPromptDiagnostics,
  getReferenceDiagnostics,
  type ContextReferenceResolver,
  type PromptDiagnostic,
  type PromptDiagnosticContext,
} from "../utils/PromptDiagnosticRules";
import { parseWorkflowDocumentRoot } from "./WorkflowDocumentLocation";
import { getWorkflowTextSpans } from "./WorkflowPromptRanges";
import { isRecord, type WorkflowPath } from "./WorkflowLocationTypes";
import type { WorkflowTextSpan } from "./WorkflowTextDecoding";
import { resolveNullable } from "../types/ExecutionPropertyResolver";
import type { PromptCompletionWorkflowContext } from "./PromptContextCompletions";

/**
 * Prompt-text diagnostics for a whole ctrlyoke file: every prompt value runs
 * through the shared rules on its decoded text, and each result is mapped back
 * to a document offset. Pure: the host injects reference resolution.
 */

/** The members of a parallel group entry, or undefined for a plain step. */
function parallelMembers(entry: unknown): unknown[] | undefined {
  const members = isRecord(entry)
    ? entry[PROMPT_PROPERTIES.PARALLEL]
    : undefined;
  return Array.isArray(members) ? members : undefined;
}

/** Steps an entry contributes to the flat step list (a plain step counts one). */
function flatStepCount(entry: unknown): number {
  return parallelMembers(entry)?.length ?? 1;
}

function promptField(span: WorkflowTextSpan): PromptDiagnosticField {
  return span.field === END_CONDITION_PROPERTIES.RETRY_PROMPT ||
    span.field === END_CONDITION_PROPERTIES.PASS_RETRY_PROMPT
    ? PROMPT_DIAGNOSTIC_FIELDS.RETRY_PROMPT
    : PROMPT_DIAGNOSTIC_FIELDS.PROMPT;
}

/**
 * A `.prompt.md` body can run as its own one-step workflow, but a workflow's
 * step `prompt`, `finalStep` or `retryPrompt`/`passRetryPrompt` can also name
 * the file, and the executor then swaps the body in before prior-context and
 * condition-output expansion (`WorkflowExecutor.resolveEffectivePrompt`). The
 * file cannot say which position it will run in, so every position-dependent
 * rule takes the most permissive view: any number of prior steps, a final
 * step, retry-prompt fields. Rules that hold everywhere (unknown
 * condition fields, unresolved files) still apply.
 */
const PROMPT_MARKDOWN_SPAN_CONTEXT: PromptDiagnosticContext = {
  stepIndex: 0,
  stepCount: Number.POSITIVE_INFINITY,
  hasFinalStep: true,
  hasPreCondition: true,
  hasEndCondition: true,
  field: PROMPT_DIAGNOSTIC_FIELDS.RETRY_PROMPT,
};

/**
 * What the file says about where a prompt sits. `stepCount` counts the flat
 * steps before it (a parallel group's members share the group's start, and the
 * final step sees every step). A workflow-level default such as the root
 * `endCondition.retryPrompt` applies to every step, so it is judged from the
 * most permissive one, the final step's view. `hasPreCondition` is always
 * true: a step can inherit a pre-condition from the workflow or the global
 * default, and the file cannot say which, so the "no pre-condition" rule stays
 * quiet rather than guess. A `.prompt.md` body gets
 * {@link PROMPT_MARKDOWN_SPAN_CONTEXT} for the same reason.
 */
export function getSpanContext(
  span: WorkflowTextSpan,
  root: unknown,
  settingsPreCondition?: unknown
): PromptDiagnosticContext {
  if (span.kind === CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN) {
    return PROMPT_MARKDOWN_SPAN_CONTEXT;
  }
  const fields = isRecord(root) ? root : {};
  const steps = Array.isArray(fields[PROMPT_PROPERTIES.STEPS])
    ? (fields[PROMPT_PROPERTIES.STEPS] as unknown[])
    : [];
  const path: WorkflowPath = span.path;
  let stepIndex = 0;
  // Final-step and workflow-level text see every step.
  let stepCount = steps.reduce<number>(
    (n, entry) => n + flatStepCount(entry),
    0
  );
  let owner: unknown = root;
  let promptOwner: unknown;
  if (path[0] === PROMPT_PROPERTIES.FINAL_STEP) {
    owner = fields[PROMPT_PROPERTIES.FINAL_STEP];
    promptOwner = owner;
    stepIndex = stepCount;
  } else if (
    path[0] === PROMPT_PROPERTIES.STEPS &&
    typeof path[1] === "number"
  ) {
    stepIndex = path[1];
    stepCount = steps
      .slice(0, stepIndex)
      .reduce<number>((n, entry) => n + flatStepCount(entry), 0);
    const entry = steps[stepIndex];
    promptOwner =
      path[2] === PROMPT_PROPERTIES.PARALLEL && typeof path[3] === "number"
        ? parallelMembers(entry)?.[path[3]]
        : entry;
    owner = promptOwner;
  } else {
    // Workflow-level prompts have no fixed execution position; use the most
    // permissive view, after every queued step.
    stepIndex = stepCount;
  }
  const effectivePreCondition =
    promptOwner && typeof promptOwner === "object"
      ? resolveNullable(
          (promptOwner as Record<string, unknown>)[
            PROMPT_PROPERTIES.PRE_CONDITION
          ],
          fields[PROMPT_PROPERTIES.PRE_CONDITION],
          settingsPreCondition
        ).value
      : undefined;
  return {
    stepIndex,
    stepCount,
    hasFinalStep:
      fields[PROMPT_PROPERTIES.FINAL_STEP] !== undefined &&
      fields[PROMPT_PROPERTIES.FINAL_STEP] !== null,
    hasPreCondition:
      promptOwner === undefined ? true : Boolean(effectivePreCondition),
    hasEndCondition:
      isRecord(owner) && owner[PROMPT_PROPERTIES.END_CONDITION] != null,
    field: promptField(span),
  };
}

/** Workflow facts used by prompt-token completions at a document offset. */
export function getWorkflowPromptCompletionContext(
  text: string,
  kind: CtrlYokeFileKind,
  offset: number
): PromptCompletionWorkflowContext | undefined {
  const span = getWorkflowTextSpans(text, kind).find(
    (candidate) =>
      candidate.exact &&
      offset >= candidate.sourceRange.start &&
      offset <= candidate.sourceRange.end
  );
  if (!span) return undefined;
  const root =
    kind === CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN
      ? undefined
      : parseWorkflowDocumentRoot(text, kind);
  const fields = isRecord(root) ? root : {};
  const steps = Array.isArray(fields[PROMPT_PROPERTIES.STEPS])
    ? (fields[PROMPT_PROPERTIES.STEPS] as unknown[])
    : [];
  const diagnosticContext = getSpanContext(span, root);
  const visibleEntries = steps.slice(0, diagnosticContext.stepIndex);
  const stepNames = visibleEntries.flatMap((entry) => {
    const members = parallelMembers(entry);
    const authored = members ?? [entry];
    return authored.map((member) =>
      isRecord(member) && typeof member[PROMPT_PROPERTIES.NAME] === "string"
        ? (member[PROMPT_PROPERTIES.NAME] as string)
        : undefined
    );
  });
  const vars = isRecord(fields[PROMPT_PROPERTIES.VARS])
    ? (fields[PROMPT_PROPERTIES.VARS] as Record<string, unknown>)
    : {};
  return {
    stepNames,
    vars,
    field: diagnosticContext.field,
    hasPreCondition: diagnosticContext.hasPreCondition,
    stepCount: diagnosticContext.stepIndex,
    hasFinalStep: diagnosticContext.hasFinalStep,
  };
}

/**
 * Every prompt diagnostic in a ctrlyoke file, with `from`/`to` as offsets into
 * `text`. `.prompt.md` bodies, workflow `prompt`, `retryPrompt` and
 * `passRetryPrompt` values are all covered.
 */
export async function getWorkflowPromptDiagnostics(
  text: string,
  kind: CtrlYokeFileKind,
  resolve: ContextReferenceResolver,
  settingsPreCondition?: unknown
): Promise<PromptDiagnostic[]> {
  // An inexact span (a decoder gap) maps offsets only approximately; a squiggle
  // on the wrong characters is worse than none.
  const spans = getWorkflowTextSpans(text, kind).filter((span) => span.exact);
  if (spans.length === 0) return [];
  // Tolerant parse: one syntax error elsewhere in a half-typed file must not
  // drop the steps and flag every `$step:` reference as missing.
  const root =
    kind === CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN
      ? undefined
      : parseWorkflowDocumentRoot(text, kind);

  const perSpan = await Promise.all(
    spans.map(async (span) => {
      const diagnostics = [
        ...getPromptDiagnostics(
          span.text,
          getSpanContext(span, root, settingsPreCondition)
        ),
        ...(await getReferenceDiagnostics(span.text, resolve)),
      ];
      return diagnostics.map((diagnostic) => ({
        ...diagnostic,
        from: span.toSourceOffset(diagnostic.from),
        to: span.toSourceOffset(diagnostic.to),
      }));
    })
  );
  return perSpan.flat();
}
