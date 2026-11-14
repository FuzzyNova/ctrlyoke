import type { ResolvedProperties } from "./SettingsPropertyResolver";
import type {
  PromptFile,
  ScriptStep,
  WorkflowStep,
  WorktreeDefaultConfig,
} from "../types/CtrlYokeTypes";
import {
  findVariablePlaceholders,
  isVariableDefined,
  type VariablePlaceholder,
} from "./VariablePlaceholders";
import {
  VAR_SUBSTITUTION_KINDS,
  VAR_SUBSTITUTION_PATH_EACH_ITEM,
  VAR_SUBSTITUTION_PATH_EACH_KEY,
  VAR_SUBSTITUTION_PHASES,
  VAR_SUBSTITUTION_POLICY,
  VAR_SUBSTITUTION_UNRESOLVED,
  VAR_SUBSTITUTION_VIEWS,
  type VarSubstitutionPhase,
  type VarSubstitutionPolicyEntry,
  type VarSubstitutionTextEntry,
  type VarSubstitutionValueEntry,
  type VarSubstitutionView,
} from "./VarSubstitutionPolicy";
import {
  describeWorkflowSchemaValue,
  validateWorkflowSchemaValue,
} from "./WorkflowSchemaValidation";
import { isRecord } from "./JsonTypeGuards";
import { BOOLEAN_STRING_VALUES } from "../types/DashboardConstants";

/** `code` carried by every {@link VarSubstitutionValidationError}. */
export const VAR_SUBSTITUTION_VALIDATION_FAILURE_CODE =
  "VAR_SUBSTITUTION_VALIDATION_FAILURE";

/**
 * A substituted field failed its policy: an unresolved placeholder in a
 * strict field, a partial placeholder in a `value` field, or a value that
 * does not satisfy the field's schema. The message names the field path, the
 * variable and its value.
 */
export class VarSubstitutionValidationError extends Error {
  readonly code = VAR_SUBSTITUTION_VALIDATION_FAILURE_CODE;

  constructor(message: string) {
    super(message);
    this.name = "VarSubstitutionValidationError";
  }
}

/** `stepIndex` that labels a step view as the workflow's `finalStep`. */
const FINAL_STEP_INDEX = -1;
const NUMERIC_STRING_PATTERN = /^-?(?:\d+\.?\d*|\.\d+)$/;

const POLICY_ENTRIES: readonly VarSubstitutionPolicyEntry[] = Object.values(
  VAR_SUBSTITUTION_POLICY
);

type FieldResolver = (value: unknown, fieldPath: string) => unknown;

/**
 * Handles `{{varName}}` substitution for CLI variable injection.
 *
 * Variables flow from two sources (highest precedence first):
 *   1. CLI `--var key=value` flags (merged into PromptFile.vars before execution)
 *   2. Workflow-level `vars:` defaults in the YAML/JSON file
 *
 * Which fields are substituted, in which phase and how, is defined only by
 * `VAR_SUBSTITUTION_POLICY` (`VarSubstitutionPolicy.ts`). Every entry point
 * here walks one policy view with the same walker, so adding a field is a
 * table entry, not code.
 *
 * This is a distinct mechanism from the `CTRLYOKE_VAR_<KEY>` environment
 * variables `ScriptProcessRunner` injects into every script/condition
 * process regardless of `{{var}}` usage — that injection happens
 * unconditionally in the runner; this class only rewrites the text handed
 * to it before the process is spawned.
 *
 * In an `advisory` field a missing variable (a `{{key}}` with no matching
 * entry) remains literal and is reported by the execution layer as an
 * advisory diagnostic, which keeps workflows that document ctrlyoke syntax
 * runnable. An `error` field throws {@link VarSubstitutionValidationError}.
 */
export class VarSubstitutor {
  private static readonly SECRET_REFERENCE_PREFIX = "${secret:";

  /**
   * Substitute a workflow's `phase` fields: its root fields and every queue
   * step and `finalStep`. Returns a copy; the authored workflow is unchanged.
   */
  static substituteWorkflowView<T extends PromptFile>(
    workflow: T,
    vars: Readonly<Record<string, string>>,
    phase: VarSubstitutionPhase
  ): T {
    const result = {
      ...this.substituteWorkflowRootView(workflow, vars, phase),
    };
    if (Array.isArray(workflow.steps))
      result.steps = workflow.steps.map((step, index) =>
        this.substituteStepView(step, vars, phase, index)
      );
    if (workflow.finalStep)
      result.finalStep = this.substituteStepView(
        workflow.finalStep,
        vars,
        phase,
        FINAL_STEP_INDEX
      ) as T["finalStep"];
    return result;
  }

  /**
   * Substitute one step's `phase` fields. `stepIndex` labels failures
   * (`steps[2].timeoutSec`); `-1` is the `finalStep`. Returns the step itself
   * when nothing changes, otherwise a copy.
   */
  static substituteStepView<T extends WorkflowStep>(
    step: T,
    vars: Readonly<Record<string, string>>,
    phase: VarSubstitutionPhase,
    stepIndex = 0
  ): T {
    return this.walkView(
      step,
      VAR_SUBSTITUTION_VIEWS.STEP,
      phase,
      vars,
      stepIndex === FINAL_STEP_INDEX ? "finalStep" : `steps[${stepIndex}]`
    );
  }

  /**
   * Substitute only the workflow root's `phase` fields (`harness`,
   * `maxSteps`), leaving `steps` and `finalStep` as they are.
   */
  static substituteWorkflowRootView<T extends PromptFile>(
    workflow: T,
    vars: Readonly<Record<string, string>>,
    phase: VarSubstitutionPhase
  ): T {
    return this.walkView(
      workflow,
      VAR_SUBSTITUTION_VIEWS.WORKFLOW,
      phase,
      vars
    );
  }

  /** Resolve worktree selectors before preflight; the authored workflow stays untouched. */
  static applyToRunStartWorktree<T extends PromptFile>(
    workflow: T,
    defaultWorktree: WorktreeDefaultConfig,
    vars: Readonly<Record<string, string>>
  ): { workflow: T; defaultWorktree: WorktreeDefaultConfig } {
    const { RUN_START } = VAR_SUBSTITUTION_PHASES;
    return {
      workflow: {
        ...workflow,
        worktree: this.walkView(
          workflow.worktree,
          VAR_SUBSTITUTION_VIEWS.WORKFLOW_WORKTREE,
          RUN_START,
          vars,
          "worktree"
        ),
      },
      defaultWorktree: this.walkView(
        defaultWorktree,
        VAR_SUBSTITUTION_VIEWS.DEFAULT_WORKTREE,
        RUN_START,
        vars,
        "defaults.worktree"
      ),
    };
  }

  /**
   * Substitute all `{{key}}` placeholders in `text` using `vars`.
   * Unresolved placeholders and placeholders inside fenced code blocks remain
   * literal; see `findVariablePlaceholders` for why inline code does not
   * protect a placeholder.
   */
  static substitute(
    text: string,
    vars: Record<string, string>,
    fencedCodeProtected = true
  ): string {
    const substitutedSpans: Array<{ start: number; end: number; key: string }> =
      [];
    let substitutedText = "";
    let cursor = 0;
    for (const { from, to, name, inFence } of findVariablePlaceholders(
      text,
      fencedCodeProtected
    )) {
      if (inFence || !isVariableDefined(vars, name)) continue;
      const value = vars[name];
      // Variable substitution must not turn ordinary workflow data into an
      // executable managed-secret interpolation. Fail before the process
      // environment can be built, leaving downstream secret expansion out
      // of reach.
      if (value.includes(this.SECRET_REFERENCE_PREFIX)) {
        throw new Error(
          `Variable "${name}" cannot contain a managed secret reference`
        );
      }
      substitutedText += text.slice(cursor, from);
      const start = substitutedText.length;
      substitutedText += value;
      substitutedSpans.push({ start, end: substitutedText.length, key: name });
      cursor = to;
    }
    substitutedText += text.slice(cursor);

    const countSecretReferences = (value: string): number =>
      value.split(this.SECRET_REFERENCE_PREFIX).length - 1;
    if (countSecretReferences(substitutedText) > countSecretReferences(text)) {
      const contributedKey = substitutedSpans.find(({ start, end }) => {
        let referenceOffset = substitutedText.indexOf(
          this.SECRET_REFERENCE_PREFIX
        );
        while (referenceOffset !== -1) {
          const referenceEnd =
            referenceOffset + this.SECRET_REFERENCE_PREFIX.length;
          if (start < referenceEnd && end > referenceOffset) return true;
          referenceOffset = substitutedText.indexOf(
            this.SECRET_REFERENCE_PREFIX,
            referenceOffset + 1
          );
        }
        return false;
      });
      if (contributedKey) {
        throw new Error(
          `Variable "${contributedKey.key}" cannot contain a managed secret reference`
        );
      }
    }

    return substitutedText;
  }

  /**
   * Find unresolved placeholders outside fenced code blocks. Results are
   * unique and retain their authored `{{name}}` spelling for diagnostics.
   */
  static findUnresolvedVariables(
    text: string,
    vars: Record<string, string>
  ): string[] {
    const found = new Set<string>();
    for (const { from, to, name, inFence } of findVariablePlaceholders(text)) {
      if (inFence || isVariableDefined(vars, name)) continue;
      found.add(text.slice(from, to));
    }
    return [...found];
  }

  /**
   * Apply var substitution to prompt text: the authored prompt, a prompt-file
   * path, or the loaded file's text. Fenced code stays literal.
   */
  static applyToPromptText(
    promptText: string,
    vars: Readonly<Record<string, string>>
  ): string {
    if (!promptText) return promptText;
    return this.walkView(
      promptText,
      VAR_SUBSTITUTION_VIEWS.PROMPT_TEXT,
      VAR_SUBSTITUTION_PHASES.DISPATCH,
      vars,
      "prompt"
    );
  }

  /**
   * Apply var substitution to the resolved-properties view: `model`,
   * `additionalArgs`, hooks, conditions, `executionMode`, `errorBehavior`
   * and the other inherited execution properties. Resolved properties merge
   * the step, the workflow root and the settings defaults, so this one walk
   * covers a placeholder from any of them. A partial view (a script step's
   * `executionMode`/`errorBehavior`) walks the same entries. Returns the
   * input when nothing changes, otherwise a copy.
   */
  static applyToResolvedProperties<T extends Partial<ResolvedProperties>>(
    props: T,
    vars: Readonly<Record<string, string>>
  ): T {
    return this.walkView(
      props,
      VAR_SUBSTITUTION_VIEWS.RESOLVED_PROPERTIES,
      VAR_SUBSTITUTION_PHASES.DISPATCH,
      vars
    );
  }

  /**
   * Apply var substitution to a script step's `script` and `env`.
   * Returns the input when nothing changes, otherwise a copy.
   */
  static applyToScriptStep(
    step: ScriptStep,
    vars: Readonly<Record<string, string>>
  ): ScriptStep {
    return this.walkView(
      step,
      VAR_SUBSTITUTION_VIEWS.SCRIPT_STEP,
      VAR_SUBSTITUTION_PHASES.DISPATCH,
      vars
    );
  }

  /**
   * The one walker: apply every policy entry of `view` and `phase` to
   * `target`, copying only the objects on a changed path.
   */
  private static walkView<T>(
    target: T,
    view: VarSubstitutionView,
    phase: VarSubstitutionPhase,
    vars: Readonly<Record<string, string>>,
    fieldPrefix = ""
  ): T {
    let result: unknown = target;
    for (const entry of POLICY_ENTRIES) {
      if (entry.view !== view || entry.phase !== phase) continue;
      const resolve: FieldResolver = (value, fieldPath) =>
        entry.kind === VAR_SUBSTITUTION_KINDS.VALUE
          ? this.resolveValueField(entry, value, vars, fieldPath)
          : this.resolveTextField(entry, value, vars, fieldPath);
      result = this.walkPath(result, entry, 0, undefined, fieldPrefix, resolve);
    }
    return result as T;
  }

  private static walkPath(
    node: unknown,
    entry: VarSubstitutionPolicyEntry,
    depth: number,
    owner: Record<string, unknown> | undefined,
    fieldPath: string,
    resolve: FieldResolver
  ): unknown {
    if (depth === entry.path.length) return resolve(node, fieldPath);
    const segment = entry.path[depth]!;
    if (segment === VAR_SUBSTITUTION_PATH_EACH_ITEM) {
      if (!Array.isArray(node)) return node;
      let copy: unknown[] | undefined;
      node.forEach((item: unknown, index) => {
        const next = this.walkPath(
          item,
          entry,
          depth + 1,
          undefined,
          `${fieldPath}[${index}]`,
          resolve
        );
        if (next === item) return;
        copy ??= [...node];
        copy[index] = next;
      });
      return copy ?? node;
    }
    if (!isRecord(node)) return node;
    let keys: string[];
    if (segment === VAR_SUBSTITUTION_PATH_EACH_KEY) {
      const literal = entry.literalKeysFrom
        ? owner?.[entry.literalKeysFrom]
        : undefined;
      const literalKeys = new Set(Array.isArray(literal) ? literal : []);
      keys = Object.keys(node).filter((key) => !literalKeys.has(key));
    } else {
      keys = Object.prototype.hasOwnProperty.call(node, segment)
        ? [segment]
        : [];
    }
    let copy: Record<string, unknown> | undefined;
    for (const key of keys) {
      const child = node[key];
      const next = this.walkPath(
        child,
        entry,
        depth + 1,
        node,
        fieldPath ? `${fieldPath}.${key}` : key,
        resolve
      );
      if (next === child) continue;
      copy ??= { ...node };
      copy[key] = next;
    }
    return copy ?? node;
  }

  private static resolveTextField(
    entry: VarSubstitutionTextEntry,
    value: unknown,
    vars: Readonly<Record<string, string>>,
    fieldPath: string
  ): unknown {
    if (typeof value !== "string") return value;
    const placeholders = findVariablePlaceholders(
      value,
      entry.fencedCodeProtected
    ).filter((placeholder) => !placeholder.inFence);
    if (entry.unresolved === VAR_SUBSTITUTION_UNRESOLVED.ERROR) {
      const missing = placeholders.find(
        (placeholder) => !isVariableDefined(vars, placeholder.name)
      );
      if (missing) throw this.unresolvedError(fieldPath, missing, value);
    }
    const substituted =
      placeholders.length > 0
        ? this.substitute(value, vars, entry.fencedCodeProtected)
        : value;
    if (!entry.postValidate) return substituted;
    const converted = entry.postValidate.convert(substituted);
    if (converted !== undefined) return converted;
    const source = placeholders[0]
      ? `variable "${placeholders[0].name}" is`
      : "value is";
    throw new VarSubstitutionValidationError(
      `${fieldPath}: ${source} "${substituted}", expected ${entry.postValidate.expected}.`
    );
  }

  private static resolveValueField(
    entry: VarSubstitutionValueEntry,
    value: unknown,
    vars: Readonly<Record<string, string>>,
    fieldPath: string
  ): unknown {
    if (typeof value !== "string") return value;
    const placeholders = findVariablePlaceholders(
      value,
      entry.fencedCodeProtected
    );
    if (placeholders.length === 0) return value;
    const placeholder = placeholders[0]!;
    if (
      placeholders.length !== 1 ||
      placeholder.from !== 0 ||
      placeholder.to !== value.length
    ) {
      throw new VarSubstitutionValidationError(
        `${fieldPath}: "${value}" must be one whole-value placeholder such as {{name}}.`
      );
    }
    if (!isVariableDefined(vars, placeholder.name)) {
      if (entry.unresolved === VAR_SUBSTITUTION_UNRESOLVED.ERROR)
        throw this.unresolvedError(fieldPath, placeholder, value);
      return value;
    }
    const raw = vars[placeholder.name]!;
    const coerced = this.coerceValue(raw);
    if (!validateWorkflowSchemaValue(entry.schema, coerced)) {
      throw new VarSubstitutionValidationError(
        `${fieldPath}: variable "${placeholder.name}" is "${raw}", expected ${describeWorkflowSchemaValue(entry.schema)}.`
      );
    }
    return coerced;
  }

  /** `"true"`/`"false"` become booleans and numeric text a number. */
  private static coerceValue(raw: string): unknown {
    if (raw === BOOLEAN_STRING_VALUES.TRUE) return true;
    if (raw === BOOLEAN_STRING_VALUES.FALSE) return false;
    return NUMERIC_STRING_PATTERN.test(raw) ? Number(raw) : raw;
  }

  private static unresolvedError(
    fieldPath: string,
    placeholder: VariablePlaceholder,
    value: string
  ): VarSubstitutionValidationError {
    return new VarSubstitutionValidationError(
      `${fieldPath}: variable "${placeholder.name}" in "${value}" is not defined.`
    );
  }
}
