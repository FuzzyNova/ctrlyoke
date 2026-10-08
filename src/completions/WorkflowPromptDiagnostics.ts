import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
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
import { getWorkflowTextSpans } from "./WorkflowPromptRanges";
import type { WorkflowPath } from "./WorkflowLocationTypes";
import type { WorkflowTextSpan } from "./WorkflowTextDecoding";

/**
 * Prompt-text diagnostics for a whole ctrlyoke file: every prompt value runs
 * through the shared rules on its decoded text, and each result is mapped back
 * to a document offset. Pure: the host injects reference resolution.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkflowRoot(text: string, kind: CtrlYokeFileKind): unknown {
  try {
    return kind === CTRLYOKE_FILE_KINDS.WORKFLOW_JSON
      ? parseJsonc(text, [], { allowTrailingComma: true })
      : parseYaml(text);
  } catch {
    return undefined;
  }
}

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
 * What the file says about where a prompt sits. `stepCount` counts the flat
 * steps before it (a parallel group's members share the group's start, and the
 * final step sees every step). A `.prompt.md` file is one step with no final
 * step. `hasPreCondition` is always true: a step can inherit a pre-condition
 * from the workflow or the global default, and the file cannot say which, so
 * the "no pre-condition" rule stays quiet rather than guess.
 */
function getSpanContext(
  span: WorkflowTextSpan,
  root: unknown
): PromptDiagnosticContext {
  const fields = isRecord(root) ? root : {};
  const steps = Array.isArray(fields[PROMPT_PROPERTIES.STEPS])
    ? (fields[PROMPT_PROPERTIES.STEPS] as unknown[])
    : [];
  const path: WorkflowPath = span.path;
  let stepIndex = 0;
  let stepCount = 0;
  let owner: unknown = root;
  if (path[0] === PROMPT_PROPERTIES.FINAL_STEP) {
    stepCount = steps.reduce<number>((n, entry) => n + flatStepCount(entry), 0);
    owner = fields[PROMPT_PROPERTIES.FINAL_STEP];
  } else if (
    path[0] === PROMPT_PROPERTIES.STEPS &&
    typeof path[1] === "number"
  ) {
    stepIndex = path[1];
    stepCount = steps
      .slice(0, stepIndex)
      .reduce<number>((n, entry) => n + flatStepCount(entry), 0);
    const entry = steps[stepIndex];
    owner =
      path[2] === PROMPT_PROPERTIES.PARALLEL && typeof path[3] === "number"
        ? parallelMembers(entry)?.[path[3]]
        : entry;
  }
  return {
    stepIndex,
    stepCount,
    hasFinalStep:
      fields[PROMPT_PROPERTIES.FINAL_STEP] !== undefined &&
      fields[PROMPT_PROPERTIES.FINAL_STEP] !== null,
    hasPreCondition: true,
    hasEndCondition:
      isRecord(owner) && owner[PROMPT_PROPERTIES.END_CONDITION] != null,
    field: promptField(span),
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
  resolve: ContextReferenceResolver
): Promise<PromptDiagnostic[]> {
  const spans = getWorkflowTextSpans(text, kind);
  if (spans.length === 0) return [];
  const root =
    kind === CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN
      ? undefined
      : parseWorkflowRoot(text, kind);

  const perSpan = await Promise.all(
    spans.map(async (span) => {
      const diagnostics = [
        ...getPromptDiagnostics(span.text, getSpanContext(span, root)),
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
