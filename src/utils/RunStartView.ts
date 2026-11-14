import type {
  PromptFile,
  WorkflowStep,
  WorktreeDefaultConfig,
} from "../types/CtrlYokeTypes";
import { VarSubstitutor } from "./VarSubstitutor";
import {
  VAR_SUBSTITUTION_PHASES,
  VAR_SUBSTITUTION_POLICY,
  VAR_SUBSTITUTION_VIEWS,
  type VarSubstitutionView,
} from "./VarSubstitutionPolicy";

/** `stepIndex` that labels a step view as the workflow's `finalStep`. */
const FINAL_STEP_INDEX = -1;

/** Top-level keys a view's run-start policy entries read. */
function runStartKeys(view: VarSubstitutionView): readonly string[] {
  return [
    ...new Set(
      Object.values(VAR_SUBSTITUTION_POLICY).flatMap((entry) =>
        entry.view === view &&
        entry.phase === VAR_SUBSTITUTION_PHASES.RUN_START &&
        entry.path[0] !== undefined
          ? [entry.path[0]]
          : []
      )
    ),
  ];
}

const ROOT_KEYS = runStartKeys(VAR_SUBSTITUTION_VIEWS.WORKFLOW);
const STEP_KEYS = runStartKeys(VAR_SUBSTITUTION_VIEWS.STEP);

function pick(
  source: object,
  keys: readonly string[]
): Record<string, unknown> {
  const record = source as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of keys)
    if (Object.prototype.hasOwnProperty.call(record, key))
      picked[key] = record[key];
  return picked;
}

/** `target` itself when no field changed, otherwise a copy with `resolved`. */
function withResolved<T extends object>(
  target: T,
  resolved: Record<string, unknown>
): T {
  const record = target as Record<string, unknown>;
  return Object.keys(resolved).every((key) => record[key] === resolved[key])
    ? target
    : { ...target, ...resolved };
}

/**
 * One run's run-start resolution: the variables the run started with and the
 * run-start fields (`harness`, `enabled`, `maxSteps`, worktree selectors)
 * resolved with them.
 *
 * Startup and continue build it once, before preflight, and hand it to the
 * executor and parallel-group preflight, which never run the run-start phase
 * themselves. The authored definition, and so the run file, keeps its
 * placeholders: a continue with changed vars builds a new view.
 *
 * Steps may be appended or edited while the run executes, so step and root
 * fields are resolved against the live definition, memoized by the authored
 * values: an unchanged field is resolved once per run, and an edited or
 * appended one once per authored value.
 */
export class RunStartView {
  private readonly resolved = new Map<string, Record<string, unknown>>();

  private constructor(
    /** The run-start-substituted workflow as it stood at run start. */
    readonly workflow: PromptFile,
    /** The settings `defaults.worktree` with its run-start selectors resolved. */
    readonly defaultWorktree: WorktreeDefaultConfig | undefined,
    /** The variables this run resolves every phase with. */
    readonly vars: Readonly<Record<string, string>>
  ) {}

  /**
   * Resolve `workflow`'s run-start fields. Throws
   * `VarSubstitutionValidationError` when one fails its policy, before any
   * run-start side effect.
   */
  static resolve(
    workflow: PromptFile,
    defaultWorktree?: WorktreeDefaultConfig,
    vars: Readonly<Record<string, string>> = workflow.vars ?? {}
  ): RunStartView {
    const frozenVars = Object.freeze({ ...vars });
    const { RUN_START } = VAR_SUBSTITUTION_PHASES;
    const worktree =
      defaultWorktree === undefined
        ? { workflow, defaultWorktree: undefined }
        : VarSubstitutor.applyToRunStartWorktree(
            workflow,
            defaultWorktree,
            frozenVars
          );
    return new RunStartView(
      VarSubstitutor.substituteWorkflowView(
        worktree.workflow,
        frozenVars,
        RUN_START
      ),
      worktree.defaultWorktree,
      frozenVars
    );
  }

  /** `live` with this run's resolved root run-start fields. */
  applyToWorkflow<T extends PromptFile>(live: T): T {
    const resolved = this.memoize("workflow", pick(live, ROOT_KEYS), () =>
      VarSubstitutor.substituteWorkflowRootView(
        live,
        this.vars,
        VAR_SUBSTITUTION_PHASES.RUN_START
      )
    );
    return withResolved(live, resolved);
  }

  /**
   * `step` with its run-start fields resolved. `stepIndex` labels failures;
   * `-1` is the `finalStep`.
   */
  resolveStep<T extends WorkflowStep>(step: T, stepIndex: number): T {
    const scope =
      stepIndex === FINAL_STEP_INDEX ? "finalStep" : `steps[${stepIndex}]`;
    const resolved = this.memoize(scope, pick(step, STEP_KEYS), () =>
      VarSubstitutor.substituteStepView(
        step,
        this.vars,
        VAR_SUBSTITUTION_PHASES.RUN_START,
        stepIndex
      )
    );
    return withResolved(step, resolved);
  }

  private memoize(
    scope: string,
    authored: Record<string, unknown>,
    resolve: () => object
  ): Record<string, unknown> {
    const keys = Object.keys(authored);
    const key = `${scope}:${JSON.stringify(authored)}`;
    let resolved = this.resolved.get(key);
    if (!resolved) {
      resolved = pick(resolve(), keys);
      this.resolved.set(key, resolved);
    }
    return resolved;
  }
}
