/**
 * Prompt-text lint rules shared by every editor that shows ctrlyoke prompts.
 *
 * Pure: no `vscode`, no DOM, no `fs`, so the dashboard's CodeMirror editor and
 * the VS Code diagnostics provider apply identical rules and messages. Hosts
 * supply the facts the text alone can't (step counts, whether a pre-condition
 * exists, and reference resolution) and map {@link PromptDiagnostic} onto their
 * own diagnostic type.
 *
 * Code ranges always come from `findCodeRanges` here, never from the caller, so
 * there is one definition of literal text.
 */

import {
  PRIOR_CONTEXT_REFERENCE_KINDS,
  PRIOR_CONTEXT_DETAILS,
  PRIOR_CONTEXT_SUMMARY_PREFIX,
  PROMPT_DIAGNOSTIC_CODES,
  PROMPT_DIAGNOSTIC_FIELDS,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
  type PromptDiagnosticCode,
  type PromptDiagnosticField,
  type PromptDiagnosticSeverity,
} from "../types/DashboardConstants";
import {
  findConditionOutputRefs,
  findContextReferenceMatches,
  findInlinePriorContextRefs,
  findUnknownConditionOutputFields,
  findCodeRanges,
  isInCodeRange,
  type ContextReferenceMatch,
} from "./PromptReferenceScanner";
import { formatRangeNotation } from "./RangeNotationParser";
import { createInlinePriorContextReferencePattern } from "./ReferencePatterns";
import { parseInlinePriorContextBody } from "./FileReferenceParser";
import {
  findVariablePlaceholders,
  isVariableDefined,
} from "./VariablePlaceholders";

/** What the text alone can't say about where it sits in a workflow. */
export interface PromptDiagnosticContext {
  /** Zero-based index of the step the text belongs to. */
  stepIndex: number;
  /** Number of steps available before this one for `$previous`/`$step:N`. */
  stepCount: number;
  hasFinalStep: boolean;
  hasPreCondition: boolean;
  hasEndCondition: boolean;
  field: PromptDiagnosticField;
  /**
   * The workflow's `vars` defaults. Omitted when the text has no knowable set
   * of vars (a `.prompt.md` body can run under any workflow), which turns the
   * undefined-variable rule off rather than flagging every placeholder.
   */
  vars?: Readonly<Record<string, unknown>>;
}

export interface PromptDiagnostic {
  from: number;
  to: number;
  severity: PromptDiagnosticSeverity;
  code: PromptDiagnosticCode;
  message: string;
  /** Extra text a host shows on its own line (the offending reference). */
  detail?: string;
  /** Replacement text for the range, offered by hosts as quick fixes. */
  replacements?: string[];
  /**
   * The undefined variable's name on a `VARIABLE_UNDEFINED` diagnostic, for
   * hosts that offer an "add it to the workflow's vars" quick fix.
   */
  variableName?: string;
}

export interface ContextReferenceValidationResult {
  id: string;
  exists: boolean;
  message?: string;
  /** CompletionItemKind, resolved live for #sym: refs so the chip can show the real symbol-kind icon. */
  symbolKind?: number;
  /**
   * "Did you mean?" replacement reference tokens (e.g. `@src/foo/Bar.ts`) for a
   * not-found @file / @directory ref, ranked by the extension host
   * (getPathSuggestions). Absent/empty when the reference resolves or no close
   * match exists.
   */
  suggestions?: string[];
}

/** How much work a host's reference resolver does beyond "does it exist". */
export interface ContextReferenceValidationOptions {
  /**
   * Look up each `#sym:` reference's live symbol kind for
   * {@link ContextReferenceValidationResult.symbolKind}. That costs a
   * document-symbol query per reference (plus a workspace-symbol query on a
   * miss), so a host that never shows the kind (VS Code diagnostics) skips it.
   */
  resolveSymbolKind: boolean;
}

export type IdentifiedContextReference = ContextReferenceMatch & { id: string };

/** Resolves references against the workspace; injected by each host. */
export type ContextReferenceResolver = (
  references: IdentifiedContextReference[]
) => Promise<ContextReferenceValidationResult[]>;

export interface PriorContextRefCheck {
  from: number;
  to: number;
  token: string;
  /** False when the reference can never be satisfied at this position. */
  valid: boolean;
  diagnostic?: PromptDiagnostic;
}

/** One reference found in the text with its resolution result, if any. */
export interface ResolvedPromptReference {
  reference: IdentifiedContextReference;
  text: string;
  inCode: boolean;
  result?: ContextReferenceValidationResult;
}

const NO_PRIOR_STEPS_MESSAGE =
  "Prior context not found — no prior steps are available before this step";
const NO_FINAL_STEP_MESSAGE =
  "Prior context not found — no final step is configured";
const EXPANSION_SUPPRESSED_MESSAGE =
  "Context expansion suppressed — this reference won't be expanded inside code";

/**
 * Check every `$previous`/`$all`/`$finalStep`/`$step:N` reference outside code.
 * A partially satisfiable `$previous:N` yields an info diagnostic but stays
 * `valid`.
 */
export function checkPriorContextRefs(
  text: string,
  context: Pick<PromptDiagnosticContext, "stepCount" | "hasFinalStep">
): PriorContextRefCheck[] {
  const { stepCount, hasFinalStep } = context;
  const codeRanges = findCodeRanges(text);
  const checks: PriorContextRefCheck[] = [];

  for (const ref of findInlinePriorContextRefs(text)) {
    if (isInCodeRange(ref.from, ref.to, codeRanges)) continue;

    const parsed = ref.ref;
    let message: string | undefined;
    let code: PromptDiagnosticCode | undefined;
    // A partially satisfiable ref warns without marking the chip invalid.
    let resolvable = false;
    if (
      parsed.kind === PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS ||
      parsed.kind === PRIOR_CONTEXT_REFERENCE_KINDS.ALL
    ) {
      if (stepCount <= 0) {
        code = PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_NO_PRIOR_STEPS;
        message = NO_PRIOR_STEPS_MESSAGE;
      } else if (
        parsed.kind === PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS &&
        parsed.count !== undefined &&
        parsed.count > stepCount
      ) {
        // Not an error at runtime (it takes what exists), but the
        // author asked for more than this position can ever supply.
        resolvable = true;
        code = PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_COUNT_CAPPED;
        message = `Only ${stepCount} prior ${stepCount === 1 ? "step is" : "steps are"} available before this step — $previous:${parsed.count} will include at most ${stepCount}`;
      }
    } else if (
      parsed.kind === PRIOR_CONTEXT_REFERENCE_KINDS.FINAL_STEP ||
      parsed.kind === PRIOR_CONTEXT_REFERENCE_KINDS.ALL_FINAL_STEP
    ) {
      if (!hasFinalStep) {
        code = PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_NO_FINAL_STEP;
        message = NO_FINAL_STEP_MESSAGE;
      }
    } else if (parsed.kind === PRIOR_CONTEXT_REFERENCE_KINDS.STEP) {
      const outOfRange = parsed.indices.filter((i) => i < 1 || i > stepCount);
      if (outOfRange.length > 0) {
        const label =
          outOfRange.length === 1
            ? `step ${outOfRange[0]} does not exist`
            : `steps ${formatRangeNotation(outOfRange)} do not exist`;
        code = PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_STEP_MISSING;
        message = `Prior context not found — ${label}`;
      }
    }

    checks.push({
      from: ref.from,
      to: ref.to,
      token: ref.token,
      valid: !message || resolvable,
      diagnostic:
        message && code
          ? {
              from: ref.from,
              to: ref.to,
              severity: resolvable
                ? COMPATIBILITY_DIAGNOSTIC_SEVERITIES.INFO
                : COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
              code,
              message,
            }
          : undefined,
    });
  }

  return checks;
}

/**
 * Diagnose malformed `$summary:` selectors. Valid forms are handled by the
 * normal prior-context parser and receive the same position diagnostics.
 */
export function getInvalidPriorContextSummaryDiagnostics(
  text: string
): PromptDiagnostic[] {
  const codeRanges = findCodeRanges(text);
  const diagnostics: PromptDiagnostic[] = [];
  for (const match of text.matchAll(createInlinePriorContextReferencePattern())) {
    if (!(match[1] === PRIOR_CONTEXT_DETAILS.SUMMARY || match[1].startsWith(PRIOR_CONTEXT_SUMMARY_PREFIX)) || parseInlinePriorContextBody(match[1])) continue;
    const from = match.index;
    const to = from + match[0].length;
    if (isInCodeRange(from, to, codeRanges)) continue;
    diagnostics.push({
      from,
      to,
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
      code: PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_INVALID,
      message: `Unknown or invalid prior-context selector: $${match[1]}`,
    });
  }
  return diagnostics;
}

/**
 * Prior-context diagnostics only; see {@link checkPriorContextRefs}.
 */
export function getPriorContextDiagnostics(
  text: string,
  context: Pick<PromptDiagnosticContext, "stepCount" | "hasFinalStep">
): PromptDiagnostic[] {
  return [
    ...checkPriorContextRefs(text, context).flatMap((check) =>
      check.diagnostic ? [check.diagnostic] : []
    ),
    ...getInvalidPriorContextSummaryDiagnostics(text),
  ];
}

/** `$preCondition:`/`$endCondition:` refs that are unavailable or misspelled. */
export function getConditionOutputDiagnostics(
  text: string,
  context: Pick<PromptDiagnosticContext, "hasPreCondition" | "field">
): PromptDiagnostic[] {
  const diagnostics: PromptDiagnostic[] = [];
  const codeRanges = findCodeRanges(text);

  for (const ref of findConditionOutputRefs(text)) {
    if (isInCodeRange(ref.from, ref.to, codeRanges)) continue;

    if (
      ref.phase === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION &&
      !context.hasPreCondition
    ) {
      diagnostics.push({
        from: ref.from,
        to: ref.to,
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        code: PROMPT_DIAGNOSTIC_CODES.CONDITION_NO_PRE_CONDITION,
        message: `$preCondition:${ref.field} has no effect — this step has no pre-condition configured`,
      });
    } else if (
      ref.phase === SCRIPT_OUTPUT_SOURCES.END_CONDITION &&
      context.field !== PROMPT_DIAGNOSTIC_FIELDS.RETRY_PROMPT
    ) {
      diagnostics.push({
        from: ref.from,
        to: ref.to,
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        code: PROMPT_DIAGNOSTIC_CODES.CONDITION_END_CONDITION_OUTSIDE_RETRY,
        message: `$endCondition:${ref.field} is only available in the retry prompt, not the initial prompt`,
      });
    }
  }

  for (const ref of findUnknownConditionOutputFields(text)) {
    if (isInCodeRange(ref.from, ref.to, codeRanges)) continue;
    const replacement = ref.suggestion
      ? `$${ref.phase}:${ref.suggestion}`
      : undefined;
    diagnostics.push({
      from: ref.from,
      to: ref.to,
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
      code: PROMPT_DIAGNOSTIC_CODES.CONDITION_FIELD_UNKNOWN,
      message: `Unknown field "${ref.field}" for $${ref.phase} — it will not be expanded${
        replacement ? `. Did you mean ${replacement}?` : ""
      } Known fields: ${Object.values(RETRY_PROMPT_PLACEHOLDERS).join(", ")}.`,
      ...(replacement ? { replacements: [replacement] } : {}),
    });
  }

  return diagnostics;
}

/**
 * `{{name}}` placeholders the workflow's `vars` don't define. A warning, not
 * an error: the CLI's `--var name=value` can still supply the value at run
 * time, and without one the placeholder is sent as literal text. Fenced
 * placeholders are never substituted, so they are never flagged.
 */
export function getUndefinedVariableDiagnostics(
  text: string,
  vars: Readonly<Record<string, unknown>>
): PromptDiagnostic[] {
  return findVariablePlaceholders(text)
    .filter(({ name, inFence }) => !inFence && !isVariableDefined(vars, name))
    .map(({ from, to, name }) => ({
      from,
      to,
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
      code: PROMPT_DIAGNOSTIC_CODES.VARIABLE_UNDEFINED,
      message: `Variable "${name}" is not defined in this workflow's vars — it is sent as literal text unless passed with --var ${name}=<value>`,
      variableName: name,
    }));
}

/** The synchronous rules (prior context, condition output, vars) over the whole text. */
export function getPromptDiagnostics(
  text: string,
  context: PromptDiagnosticContext
): PromptDiagnostic[] {
  return [
    ...getPriorContextDiagnostics(text, context),
    ...getConditionOutputDiagnostics(text, context),
    ...(context.vars
      ? getUndefinedVariableDiagnostics(text, context.vars)
      : []),
  ];
}

/** Find every context reference in the text and resolve it through the host. */
export async function resolvePromptReferences(
  text: string,
  resolve: ContextReferenceResolver
): Promise<ResolvedPromptReference[]> {
  const codeRanges = findCodeRanges(text);
  const references: IdentifiedContextReference[] = findContextReferenceMatches(
    text
  ).map((match, index) => ({
    ...match,
    id: `${match.from}:${match.to}:${match.type}:${index}`,
  }));
  if (references.length === 0) return [];

  const results = await resolve(references);
  const resultById = new Map(results.map((result) => [result.id, result]));
  return references.map((reference) => ({
    reference,
    text: text.slice(reference.from, reference.to),
    inCode: isInCodeRange(reference.from, reference.to, codeRanges),
    result: resultById.get(reference.id),
  }));
}

/** Diagnostics for references that didn't resolve, or that sit inside code. */
export function diagnoseResolvedReferences(
  resolved: ResolvedPromptReference[]
): PromptDiagnostic[] {
  return resolved.flatMap(
    ({ reference, text, inCode, result }): PromptDiagnostic[] => {
      if (inCode) {
        // Warn only when the reference points to something that actually exists —
        // the user may not realize expansion is silently suppressed.
        return result?.exists
          ? [
              {
                from: reference.from,
                to: reference.to,
                severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
                code: PROMPT_DIAGNOSTIC_CODES.EXPANSION_SUPPRESSED_IN_CODE,
                message: EXPANSION_SUPPRESSED_MESSAGE,
              },
            ]
          : [];
      }

      if (!result || result.exists) return [];

      return [
        {
          from: reference.from,
          to: reference.to,
          severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
          code: PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE,
          message: result.message || "context not found",
          detail: text,
          ...(result.suggestions?.length
            ? { replacements: result.suggestions }
            : {}),
        },
      ];
    }
  );
}

/** Reference-resolution diagnostics over the whole text. */
export async function getReferenceDiagnostics(
  text: string,
  resolve: ContextReferenceResolver
): Promise<PromptDiagnostic[]> {
  return diagnoseResolvedReferences(
    await resolvePromptReferences(text, resolve)
  );
}
