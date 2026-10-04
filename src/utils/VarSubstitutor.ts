import type { ResolvedProperties } from "./PropertyResolver";
import type {
  UserHookConfig,
  EndCondition,
  ScriptStep,
  ScriptProperties,
} from "../types/CtrlYokeTypes";
import { maskCodeRanges } from "./FileReferenceParser";
import { VARIABLE_NAME_PATTERN_SOURCE } from "./KeyValueKeyKinds";

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
 *   - preCondition `script` and `env` (shared with endCondition/scriptStep via
 *     `applyToScriptProperties`)
 *   - endCondition `script`, `env`, `retryPrompt`, `passRetryPrompt`
 *   - Script-step `script` and `env` (`applyToScriptStep`)
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
  private static readonly PLACEHOLDER_RE = new RegExp(
    `\\{\\{(${VARIABLE_NAME_PATTERN_SOURCE})\\}\\}`,
    "g"
  );

  /**
   * Substitute all `{{key}}` placeholders in `text` using `vars`.
   * Unresolved placeholders and placeholders inside fenced code blocks remain
   * literal. Inline code spans do not protect a placeholder: vars are also
   * substituted into script text, where backticks are shell command
   * substitution, and authors put vars inside inline code on purpose.
   */
  static substitute(text: string, vars: Record<string, string>): string {
    const maskedText = maskCodeRanges(text, { fencesOnly: true });
    const substitutedSpans: Array<{ start: number; end: number; key: string }> =
      [];
    let outputLengthDelta = 0;
    const substitutedText = text.replace(
      this.PLACEHOLDER_RE,
      (match, key: string, offset: number) => {
        if (maskedText.slice(offset, offset + match.length).includes("\x00")) {
          return match;
        }
        if (!Object.prototype.hasOwnProperty.call(vars, key)) {
          return match;
        }
        const value = vars[key];
        // Variable substitution must not turn ordinary workflow data into an
        // executable managed-secret interpolation. Fail before the process
        // environment can be built, leaving downstream secret expansion out
        // of reach.
        if (value.includes(this.SECRET_REFERENCE_PREFIX)) {
          throw new Error(
            `Variable "${key}" cannot contain a managed secret reference`
          );
        }
        const start = offset + outputLengthDelta;
        substitutedSpans.push({ start, end: start + value.length, key });
        outputLengthDelta += value.length - match.length;
        return value;
      }
    );

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
    const maskedText = maskCodeRanges(text, { fencesOnly: true });
    const found = new Set<string>();
    this.PLACEHOLDER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = this.PLACEHOLDER_RE.exec(text)) !== null) {
      const offset = match.index;
      if (
        maskedText.slice(offset, offset + match[0].length).includes("\x00") ||
        Object.prototype.hasOwnProperty.call(vars, match[1])
      ) {
        continue;
      }
      found.add(match[0]);
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
