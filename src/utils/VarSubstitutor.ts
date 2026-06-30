import type { ResolvedProperties } from "./PropertyResolver";
import type { UserHookConfig, EndCondition } from "../types/CtrlYokeTypes";

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
 *   - Hook commands (`resolvedProperties.hooks[].command`)
 *   - EndCondition script path
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
   * that may contain placeholders: `model`, `additionalArgs`, hook commands,
   * and endCondition script path.
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
      endCondition:
        props.endCondition !== undefined
          ? this.applyToEndCondition(props.endCondition, vars)
          : undefined,
    };
  }

  private static applyToHook(
    hook: UserHookConfig,
    vars: Record<string, string>
  ): UserHookConfig {
    return { ...hook, command: this.substitute(hook.command, vars) };
  }

  private static applyToEndCondition(
    cond: EndCondition,
    vars: Record<string, string>
  ): EndCondition {
    return {
      ...cond,
      script: this.substitute(cond.script, vars),
      retryPrompt:
        cond.retryPrompt !== undefined
          ? this.substitute(cond.retryPrompt, vars)
          : undefined,
    };
  }
}
