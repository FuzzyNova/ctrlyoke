import type { ResolvedProperties } from "./SettingsPropertyResolver";
import type {
  UserHookConfig,
  EndCondition,
  ScriptStep,
  ScriptProperties,
} from "../types/CtrlYokeTypes";
import type {
  PromptFile,
  WorkflowStep,
  WorktreeConfig,
  WorktreeDefaultConfig,
} from "../types/CtrlYokeTypes";
import {
  findVariablePlaceholders,
  isVariableDefined,
} from "./VariablePlaceholders";
import { VAR_SUBSTITUTION_POLICY } from "./VarSubstitutionPolicy";

/**
 * Handles `{{varName}}` substitution for CLI variable injection.
 *
 * Variables flow from two sources (highest precedence first):
 *   1. CLI `--var key=value` flags (merged into PromptFile.vars before execution)
 *   2. Workflow-level `vars:` defaults in the YAML/JSON file
 *
 * The supported field set, phase, and substitution behavior are defined by
 * `VAR_SUBSTITUTION_POLICY` in `VarSubstitutionPolicy.ts`.
 *
 * This is a distinct mechanism from the `CTRLYOKE_VAR_<KEY>` environment
 * variables `ScriptProcessRunner` injects into every script/condition
 * process regardless of `{{var}}` usage — that injection happens
 * unconditionally in the runner; this class only rewrites the text handed
 * to it before the process is spawned.
 *
 * Missing variables (a `{{key}}` with no matching entry) remain literal and
 * are reported by the execution layer as an advisory diagnostic. This keeps
 * workflows that document ctrlyoke syntax runnable.
 */
export class VarSubstitutor {
  private static readonly SECRET_REFERENCE_PREFIX = "${secret:";

  /** Substitution failures that must be handled through the step error policy. */
  static readonly VALIDATION_FAILURE = "VAR_SUBSTITUTION_VALIDATION_FAILURE";

  /** Build the just-in-time dispatch view without changing the authored definition. */
  static substituteWorkflowView<T extends PromptFile | WorkflowStep>(
    view: T,
    vars: Record<string, string>,
    phase: "dispatch" | "run-start",
    stepIndex = 0
  ): T {
    if (phase !== "dispatch") return view;
    const substituteField = (
      value: unknown,
      policyPath: string,
      fieldPath: string
    ): unknown => {
      if (typeof value !== "string") return value;
      const unresolved = this.findUnresolvedVariables(value, vars);
      if (unresolved.length) {
        const placeholder = unresolved[0]!;
        const name = placeholder.slice(2, -2);
        throw new Error(
          `${this.VALIDATION_FAILURE}: ${fieldPath}: variable "${name}" is unresolved, expected a defined variable.`
        );
      }
      return this.substitute(
        value,
        vars,
        VAR_SUBSTITUTION_POLICY[
          policyPath as keyof typeof VAR_SUBSTITUTION_POLICY
        ].fencedCodeProtected
      );
    };
    const substituteStep = (
      step: WorkflowStep,
      index: number
    ): WorkflowStep => {
      const fields = step as WorkflowStep & Record<string, unknown>;
      const supportedValues = [
        fields.name,
        fields.expected,
        fields.shell,
        fields.agent,
        ...(Array.isArray(fields.skills) ? fields.skills : []),
        typeof fields.sessionId === "string" ? fields.sessionId : undefined,
        ...(fields.priorContext &&
        typeof fields.priorContext === "object" &&
        !Array.isArray(fields.priorContext)
          ? [
              (fields.priorContext as Record<string, unknown>).workflow,
              (fields.priorContext as Record<string, unknown>).run,
            ]
          : []),
      ];
      if (
        Object.keys(vars).length === 0 &&
        !supportedValues.some(
          (value) => typeof value === "string" && /\{\{\w+\}\}/.test(value)
        )
      )
        return step;
      const result = { ...step } as WorkflowStep & Record<string, unknown>;
      const path = `steps[${index}]`;
      if (typeof result.name === "string")
        result.name = substituteField(
          result.name,
          "steps[].name",
          `${path}.name`
        ) as string;
      if (typeof result.expected === "string")
        result.expected = substituteField(
          result.expected,
          "steps[].expected",
          `${path}.expected`
        ) as string;
      if (typeof result.shell === "string")
        result.shell = substituteField(
          result.shell,
          "steps[].shell",
          `${path}.shell`
        ) as string;
      if (typeof result.agent === "string")
        result.agent = substituteField(
          result.agent,
          "steps[].agent",
          `${path}.agent`
        ) as string;
      if (Array.isArray(result.skills))
        result.skills = result.skills.map(
          (skill, skillIndex) =>
            substituteField(
              skill,
              "steps[].skills[]",
              `${path}.skills[${skillIndex}]`
            ) as string
        );
      if (typeof result.sessionId === "string")
        result.sessionId = substituteField(
          result.sessionId,
          "steps[].sessionId",
          `${path}.sessionId`
        ) as string;
      const prior = result["priorContext"];
      if (prior && typeof prior === "object" && !Array.isArray(prior)) {
        const priorCopy = { ...prior } as Record<string, unknown>;
        if (typeof priorCopy.workflow === "string")
          priorCopy.workflow = substituteField(
            priorCopy.workflow,
            "steps[].priorContext.workflow",
            `${path}.priorContext.workflow`
          );
        if (typeof priorCopy.run === "string") {
          const run = substituteField(
            priorCopy.run,
            "steps[].priorContext.run",
            `${path}.priorContext.run`
          );
          if (
            !/^[1-9]\d*$/.test(run as string) &&
            !/^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(
              run as string
            )
          ) {
            throw new Error(
              `${this.VALIDATION_FAILURE}: ${path}.priorContext.run: variable "run" is "${run}", expected an integer or run reference.`
            );
          }
          priorCopy.run = /^[1-9]\d*$/.test(run as string) ? Number(run) : run;
        }
        result["priorContext"] = priorCopy;
      }
      return result;
    };
    if ("steps" in view) {
      const workflow = view as PromptFile;
      return {
        ...workflow,
        steps: workflow.steps?.map((step, index) =>
          substituteStep(step, index)
        ),
        finalStep: workflow.finalStep
          ? (substituteStep(workflow.finalStep, -1) as PromptFile["finalStep"])
          : workflow.finalStep,
      } as T;
    }
    return substituteStep(view as WorkflowStep, stepIndex) as T;
  }

  /** Resolve worktree selectors before preflight; the authored workflow stays untouched. */
  static applyToRunStartWorktree<T extends PromptFile>(
    workflow: T,
    defaultWorktree: WorktreeDefaultConfig,
    vars: Record<string, string>
  ): { workflow: T; defaultWorktree: WorktreeDefaultConfig } {
    const replace = (
      config: WorktreeConfig | undefined,
      prefix: string
    ): WorktreeConfig | undefined => {
      if (!config || typeof config !== "object") return config;
      const result = { ...config } as Record<string, unknown>;
      for (const key of ["branch", "base", "directory"] as const) {
        const value = result[key];
        if (typeof value !== "string") continue;
        const field = `${prefix}.${key}`;
        const unresolved = this.findUnresolvedVariables(value, vars);
        if (unresolved.length) {
          const name = unresolved[0]!.slice(2, -2);
          throw new Error(
            `Cannot start: ${field} has unresolved variable "${name}" in value "${value}".`
          );
        }
        result[key] = this.substitute(
          value,
          vars,
          VAR_SUBSTITUTION_POLICY[field as keyof typeof VAR_SUBSTITUTION_POLICY]
            .fencedCodeProtected
        );
      }
      return result as unknown as WorktreeConfig;
    };
    return {
      workflow: {
        ...workflow,
        worktree: replace(workflow.worktree, "worktree"),
      } as T,
      defaultWorktree: replace(
        defaultWorktree,
        "defaults.worktree"
      ) as WorktreeDefaultConfig,
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
   * Apply var substitution to the prompt text string.
   * Returns the substituted string, or the original if vars is empty.
   */
  static applyToPromptText(
    promptText: string,
    vars: Record<string, string>
  ): string {
    if (!promptText || Object.keys(vars).length === 0) return promptText;
    return this.substitute(
      promptText,
      vars,
      VAR_SUBSTITUTION_POLICY["prompt.prompt"].fencedCodeProtected
    );
  }

  /**
   * Apply var substitution to all string fields of `ResolvedProperties`
   * that may contain placeholders: `model`, `additionalArgs`, hook
   * commands/env, preCondition, and endCondition.
   *
   * Returns a new object; the input is not mutated.
   */
  static applyToResolvedProperties(
    props: ResolvedProperties,
    vars: Record<string, string>
  ): ResolvedProperties {
    if (Object.keys(vars).length === 0) return props;

    return {
      ...props,
      model: this.substitute(
        props.model,
        vars,
        VAR_SUBSTITUTION_POLICY["steps[].model"].fencedCodeProtected
      ),
      additionalArgs:
        props.additionalArgs !== undefined
          ? this.substitute(
              props.additionalArgs,
              vars,
              VAR_SUBSTITUTION_POLICY["steps[].additionalArgs"]
                .fencedCodeProtected
            )
          : undefined,
      hooks:
        props.hooks !== null && props.hooks !== undefined
          ? props.hooks.map((h) => this.applyToHook(h, vars))
          : props.hooks,
      preCondition:
        props.preCondition !== undefined
          ? this.applyToScriptProperties(
              props.preCondition,
              vars,
              "preCondition.script",
              "preCondition.env.*"
            )
          : undefined,
      endCondition:
        props.endCondition !== undefined
          ? this.applyToEndCondition(props.endCondition, vars)
          : undefined,
    };
  }

  /**
   * Apply var substitution to a script step's `script` and `env`.
   * No-ops (returns the input unchanged) when `vars` is empty.
   */
  static applyToScriptStep(
    step: ScriptStep,
    vars: Record<string, string>
  ): ScriptStep {
    if (Object.keys(vars).length === 0) return step;
    return this.applyToScriptProperties(
      step,
      vars,
      "scriptStep.script",
      "scriptStep.env.*"
    );
  }

  private static applyToHook(
    hook: UserHookConfig,
    vars: Record<string, string>
  ): UserHookConfig {
    return {
      ...hook,
      command: this.substitute(
        hook.command,
        vars,
        VAR_SUBSTITUTION_POLICY["hooks[].command"].fencedCodeProtected
      ),
      ...(hook.env !== undefined && {
        env: Object.fromEntries(
          Object.entries(hook.env).map(([key, value]) => [
            key,
            this.substitute(
              value,
              vars,
              VAR_SUBSTITUTION_POLICY["hooks[].env.*"].fencedCodeProtected
            ),
          ])
        ),
      }),
    };
  }

  /**
   * Shared `script` + `env` substitution for the three consumers of
   * `ScriptProperties`: preCondition, endCondition, and scriptStep. Keeping
   * this single-sourced is what keeps those three surfaces from drifting
   * the way endCondition alone did before.
   */
  private static applyToScriptProperties<T extends ScriptProperties>(
    props: T,
    vars: Record<string, string>,
    scriptPolicy:
      "preCondition.script" | "endCondition.script" | "scriptStep.script",
    envPolicy: "preCondition.env.*" | "endCondition.env.*" | "scriptStep.env.*"
  ): T {
    return {
      ...props,
      script: this.substitute(
        props.script,
        vars,
        VAR_SUBSTITUTION_POLICY[scriptPolicy].fencedCodeProtected
      ),
      ...(props.env !== undefined && {
        env: Object.fromEntries(
          Object.entries(props.env).map(([key, value]) => [
            key,
            this.substitute(
              value,
              vars,
              VAR_SUBSTITUTION_POLICY[envPolicy].fencedCodeProtected
            ),
          ])
        ),
      }),
    };
  }

  private static applyToEndCondition(
    cond: EndCondition,
    vars: Record<string, string>
  ): EndCondition {
    return {
      ...this.applyToScriptProperties(
        cond,
        vars,
        "endCondition.script",
        "endCondition.env.*"
      ),
      retryPrompt:
        cond.retryPrompt !== undefined
          ? this.substitute(
              cond.retryPrompt,
              vars,
              VAR_SUBSTITUTION_POLICY["endCondition.retryPrompt"]
                .fencedCodeProtected
            )
          : undefined,
      passRetryPrompt:
        cond.passRetryPrompt !== undefined
          ? this.substitute(
              cond.passRetryPrompt,
              vars,
              VAR_SUBSTITUTION_POLICY["endCondition.passRetryPrompt"]
                .fencedCodeProtected
            )
          : undefined,
    };
  }
}
