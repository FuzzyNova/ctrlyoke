import type { ResolvedProperties } from "./PropertyResolver";
import type {
  UserHookConfig,
  EndCondition,
  PreCondition,
  ScriptStep,
  ScriptProperties,
} from "../types/CtrlYokeTypes";

/**
 * Handles `{{varName}}` substitution for CLI variable injection.
 *
 * Variables flow from two sources (highest precedence first):
 *   1. CLI `--var key=value` flags (merged into PromptFile.vars before execution)
 *   2. Workflow-level `vars:` defaults in the YAML/JSON file
 *
 * Substitution is applied to:
 *   - Prompt text (`prompt.prompt`)
 *   - Resolved model
 *   - Resolved additionalArgs
 *   - Hook commands and hook `env` values (`resolvedProperties.hooks[]`)
 *   - preCondition `script` and `env` (`applyToPreCondition`, shared with
 *     endCondition/scriptStep via `applyToScriptProperties`)
 *   - endCondition `script`, `env`, `retryPrompt`, `passRetryPrompt`
 *   - Script-step `script` and `env` (`applyToScriptStep`)
 *
 * This is a distinct mechanism from the `CTRLYOKE_VAR_<KEY>` environment
 * variables `ScriptProcessRunner` injects into every script/condition
 * process regardless of `{{var}}` usage — that injection happens
 * unconditionally in the runner; this class only rewrites the text handed
 * to it before the process is spawned.
 *
 * Missing variables (a `{{key}}` with no matching entry) cause a hard error
 * with a clear message indicating which placeholder is unresolved.
 */
export class VarSubstitutor {
  private static readonly PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

  /**
   * Substitute all `{{key}}` placeholders in `text` using `vars`.
   * Throws if any placeholder has no matching key in `vars`.
   */
  static substitute(text: string, vars: Record<string, string>): string {
    return text.replace(this.PLACEHOLDER_RE, (_match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) {
        throw new Error(
          `Unresolved variable "{{${key}}}" — pass --var ${key}=<value> or add it to the workflow's vars: section`
        );
      }
      return vars[key];
    });
  }

  /**
   * Returns true if `text` contains any `{{key}}` placeholder.
   */
  static hasPlaceholders(text: string): boolean {
    this.PLACEHOLDER_RE.lastIndex = 0;
    return this.PLACEHOLDER_RE.test(text);
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
    return this.substitute(promptText, vars);
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
      model: this.substitute(props.model, vars),
      additionalArgs:
        props.additionalArgs !== undefined
          ? this.substitute(props.additionalArgs, vars)
          : undefined,
      hooks:
        props.hooks !== null && props.hooks !== undefined
          ? props.hooks.map((h) => this.applyToHook(h, vars))
          : props.hooks,
      preCondition:
        props.preCondition !== undefined
          ? this.applyToScriptProperties(props.preCondition, vars)
          : undefined,
      endCondition:
        props.endCondition !== undefined
          ? this.applyToEndCondition(props.endCondition, vars)
          : undefined,
    };
  }

  /**
   * Apply var substitution to a preCondition's `script` and `env`.
   * No-ops (returns the input unchanged) when `vars` is empty.
   */
  static applyToPreCondition(
    cond: PreCondition,
    vars: Record<string, string>
  ): PreCondition {
    if (Object.keys(vars).length === 0) return cond;
    return this.applyToScriptProperties(cond, vars);
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
    return this.applyToScriptProperties(step, vars);
  }

  private static applyToHook(
    hook: UserHookConfig,
    vars: Record<string, string>
  ): UserHookConfig {
    return {
      ...hook,
      command: this.substitute(hook.command, vars),
      ...(hook.env !== undefined && {
        env: Object.fromEntries(
          Object.entries(hook.env).map(([key, value]) => [
            key,
            this.substitute(value, vars),
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
    vars: Record<string, string>
  ): T {
    return {
      ...props,
      script: this.substitute(props.script, vars),
      ...(props.env !== undefined && {
        env: Object.fromEntries(
          Object.entries(props.env).map(([key, value]) => [
            key,
            this.substitute(value, vars),
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
      ...this.applyToScriptProperties(cond, vars),
      retryPrompt:
        cond.retryPrompt !== undefined
          ? this.substitute(cond.retryPrompt, vars)
          : undefined,
      passRetryPrompt:
        cond.passRetryPrompt !== undefined
          ? this.substitute(cond.passRetryPrompt, vars)
          : undefined,
    };
  }
}
