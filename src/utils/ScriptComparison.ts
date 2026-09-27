import {
  COMPARE_SOURCES,
  DEFAULT_COMPARE_SOURCE,
  DEFAULT_SCRIPT_OPERATOR,
  SCRIPT_NUMERIC_OPERATORS,
  SCRIPT_OPERATORS,
  SCRIPT_STRING_OPERATORS,
  SCRIPT_VALUELESS_OPERATORS,
  type CompareSource,
  type ScriptOperator,
} from "../types/DashboardConstants";
import {
  COMPARE_SOURCE_OPTIONS_META,
  SCRIPT_OPERATOR_OPTIONS_META,
} from "../types/SchemaUiMetadata";

/**
 * Longest `actual` a regex is run against. A `matches` pattern is authored by the
 * user, but the text it runs against is model-influenced script output, and a
 * pathological backtrack would hang the extension host (worse than a script
 * timeout, which at least has a deadline). Truncating bounds the input instead.
 */
export const MAX_REGEX_INPUT_LENGTH = 100_000;

/** The comparison an author configured, before defaults are applied. */
export interface ScriptComparisonConfig {
  compareSource?: CompareSource;
  operator?: ScriptOperator;
  /**
   * A number is accepted so `expected: 0` works in YAML/JSON without the
   * forced quoting `returns: "0"` used to demand. Normalized to a string by
   * `resolveScriptComparison`, which every consumer goes through.
   */
  expected?: string | number;
  ignoreCase?: boolean;
}

/** Coerce an authored `expected` to the string form comparisons and verdicts use. */
export function normalizeExpected(
  expected: string | number | undefined
): string | undefined {
  return expected === undefined ? undefined : String(expected);
}

/** The script output a comparison reads from. */
export interface ScriptComparisonInput {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface ScriptComparisonResult {
  passed: boolean;
  /** The trimmed value taken from `compareSource` and compared. */
  actual: string;
}

/** Fill in the defaults so every consumer reads the same resolved triple. */
export function resolveScriptComparison(config: ScriptComparisonConfig): {
  compareSource: CompareSource;
  operator: ScriptOperator;
  expected?: string;
  ignoreCase: boolean;
} {
  return {
    compareSource: config.compareSource ?? DEFAULT_COMPARE_SOURCE,
    operator: config.operator ?? DEFAULT_SCRIPT_OPERATOR,
    expected: normalizeExpected(config.expected),
    ignoreCase: config.ignoreCase ?? false,
  };
}

/**
 * Fill the comparison defaults into a script-properties object so downstream
 * consumers (the reporter, the verdict, the CLI) receive a concrete
 * `compareSource`/`operator` pair rather than each applying its own fallback.
 */
export function resolveReportedScriptProperties<
  T extends ScriptComparisonConfig,
>(
  properties: T & { timeout?: never }
): Omit<T, "expected"> & {
  compareSource: CompareSource;
  operator: ScriptOperator;
  expected?: string;
} {
  const resolved = {
    ...properties,
    compareSource: properties.compareSource ?? DEFAULT_COMPARE_SOURCE,
    operator: properties.operator ?? DEFAULT_SCRIPT_OPERATOR,
    expected: normalizeExpected(properties.expected),
  };
  if (resolved.expected === undefined) {
    delete resolved.expected;
  }
  return resolved;
}

/** Whether `ignoreCase` has any effect for this operator. */
export function operatorUsesCase(operator: ScriptOperator): boolean {
  return SCRIPT_STRING_OPERATORS.includes(operator);
}

/** Whether this operator compares numbers, so both sides must parse as numeric. */
export function operatorIsNumeric(operator: ScriptOperator): boolean {
  return SCRIPT_NUMERIC_OPERATORS.includes(operator);
}

/** Whether this operator ignores `expected` entirely. */
export function operatorTakesNoValue(operator: ScriptOperator): boolean {
  return SCRIPT_VALUELESS_OPERATORS.includes(operator);
}

/** Pull the compared value out of a script result, trimmed. */
export function readComparisonSource(
  compareSource: CompareSource,
  input: ScriptComparisonInput
): string {
  switch (compareSource) {
    case COMPARE_SOURCES.STDERR:
      return (input.stderr ?? "").trim();
    case COMPARE_SOURCES.EXIT_CODE:
      return String(input.exitCode ?? "");
    case COMPARE_SOURCES.STDOUT:
    default:
      return (input.stdout ?? "").trim();
  }
}

function compareNumeric(
  operator: ScriptOperator,
  actual: string,
  expected: string
): boolean {
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  // A numeric operator against non-numeric text is a failed comparison, not an
  // internal error: `errorBehavior` covers a script that could not run, while a
  // wrong-typed operand is the author's own `onFail` to route. It deliberately
  // never falls back to a string comparison — that silent degradation is the
  // behavior this module replaced.
  if (
    actual.trim() === "" ||
    expected.trim() === "" ||
    !Number.isFinite(actualNumber) ||
    !Number.isFinite(expectedNumber)
  ) {
    return false;
  }
  switch (operator) {
    case SCRIPT_OPERATORS.GTE:
      return actualNumber >= expectedNumber;
    case SCRIPT_OPERATORS.GT:
      return actualNumber > expectedNumber;
    case SCRIPT_OPERATORS.LTE:
      return actualNumber <= expectedNumber;
    case SCRIPT_OPERATORS.LT:
      return actualNumber < expectedNumber;
    default:
      return false;
  }
}

function compareRegex(actual: string, pattern: string): boolean {
  try {
    // Unanchored on purpose — documented, and `^`/`$` are the author's to add.
    return new RegExp(pattern).test(actual.slice(0, MAX_REGEX_INPUT_LENGTH));
  } catch {
    // An invalid pattern cannot match anything; the schema does not validate
    // regex syntax, so this is a real reachable state rather than a guard.
    return false;
  }
}

/**
 * Evaluate a script condition. The operator always comes from the author's
 * configuration — nothing here inspects the values to pick a comparison, which
 * is what made the previous implementation's verdict depend on the output shape.
 *
 * With no `expected`, the condition is "the script exited 0" regardless of
 * `compareSource`: that is the zero-config default, not a special case, because
 * the defaults resolve to `exitCode` / `eq` / `"0"`.
 */
export function compareScriptOutput(
  config: ScriptComparisonConfig,
  input: ScriptComparisonInput
): ScriptComparisonResult {
  const { compareSource, operator, expected, ignoreCase } =
    resolveScriptComparison(config);
  const actual = readComparisonSource(compareSource, input);

  if (operator === SCRIPT_OPERATORS.IS_EMPTY) {
    return { passed: actual === "", actual };
  }
  if (operator === SCRIPT_OPERATORS.IS_NOT_EMPTY) {
    return { passed: actual !== "", actual };
  }

  if (expected === undefined) {
    // Nothing to compare against: fall back to the resolved default, which is
    // exit code 0. Stated here once rather than branched on by every caller.
    return { passed: input.exitCode === 0, actual };
  }

  if (operatorIsNumeric(operator)) {
    return { passed: compareNumeric(operator, actual, expected), actual };
  }

  if (operator === SCRIPT_OPERATORS.MATCHES) {
    return { passed: compareRegex(actual, expected), actual };
  }

  const trimmedExpected = expected.trim();
  const left = ignoreCase ? actual.toLowerCase() : actual;
  const right = ignoreCase ? trimmedExpected.toLowerCase() : trimmedExpected;

  switch (operator) {
    case SCRIPT_OPERATORS.NE:
      return { passed: left !== right, actual };
    case SCRIPT_OPERATORS.CONTAINS:
      return { passed: left.includes(right), actual };
    case SCRIPT_OPERATORS.NOT_CONTAINS:
      return { passed: !left.includes(right), actual };
    case SCRIPT_OPERATORS.EQ:
    default:
      return { passed: left === right, actual };
  }
}

/**
 * One human sentence for a configured comparison. Single-sourced so the drawer
 * hint, the execution preview, and the CLI/dashboard verdicts phrase a condition
 * identically instead of drifting apart.
 */
export function describeComparison(config: ScriptComparisonConfig): string {
  const { compareSource, operator, expected, ignoreCase } =
    resolveScriptComparison(config);

  if (expected === undefined && !operatorTakesNoValue(operator)) {
    return "Passes when the script exits with code 0.";
  }

  const sourceLabel =
    compareSource === COMPARE_SOURCES.EXIT_CODE
      ? "the exit code"
      : `${COMPARE_SOURCE_OPTIONS_META[compareSource].label.toLowerCase()}`;

  if (operatorTakesNoValue(operator)) {
    return `Passes when ${sourceLabel} ${SCRIPT_OPERATOR_OPTIONS_META[operator].label.toLowerCase()}.`;
  }

  const caseNote =
    ignoreCase && operatorUsesCase(operator) ? ", ignoring case" : "";

  if (operator === SCRIPT_OPERATORS.MATCHES) {
    return `Passes when ${sourceLabel} matches the regex /${expected}/ (unanchored — add ^ and $ to require a full match).`;
  }

  if (operatorIsNumeric(operator)) {
    return `Passes when ${sourceLabel} is ${SCRIPT_OPERATOR_OPTIONS_META[operator].label.toLowerCase()} ${expected}. Both sides must be numeric, or the check fails.`;
  }

  return `Passes when ${sourceLabel} ${SCRIPT_OPERATOR_OPTIONS_META[operator].label.toLowerCase()} "${expected}"${caseNote}.`;
}

/**
 * Whether a comparison names a source or operator but has no value to compare
 * against. `compareScriptOutput` resolves that state deterministically — it
 * falls back to "the script exited 0" and never applies the stated comparison —
 * so it is legal and runnable, just almost certainly not what was authored.
 * Every surface that reports it (the drawer, `validateWorkflowSteps`, and
 * through it `ctrlyoke validate`) asks this one function so they cannot drift
 * on which configurations count.
 */
export function isComparisonIncomplete(
  config: ScriptComparisonConfig
): boolean {
  const { compareSource, operator, expected } = resolveScriptComparison(config);
  if (expected !== undefined || operatorTakesNoValue(operator)) {
    return false;
  }
  // The untouched default already means "exits 0" and says so in its own hint,
  // so only a comparison the author actually stated is worth flagging.
  return (
    compareSource !== DEFAULT_COMPARE_SOURCE ||
    operator !== DEFAULT_SCRIPT_OPERATOR
  );
}

/** The one sentence every surface uses for `isComparisonIncomplete`. */
export function describeIncompleteComparison(
  config: ScriptComparisonConfig
): string {
  return `No value to compare against, so "${formatComparisonSubject(
    config
  )}" is ignored — this check passes when the script exits with code 0.`;
}

/**
 * The `stdout contains` half of a comparison, without the value. Verdict rows
 * that highlight the expected value separately (find-in-output) render this and
 * then the value themselves.
 */
export function formatComparisonSubject(
  config: ScriptComparisonConfig
): string {
  const { compareSource, operator } = resolveScriptComparison(config);
  const source =
    compareSource === COMPARE_SOURCES.EXIT_CODE ? "exit code" : compareSource;
  return `${source} ${SCRIPT_OPERATOR_OPTIONS_META[operator].label.toLowerCase()}`;
}

/** Compact `stdout contains 0 failing` form for verdict rows. */
export function formatComparison(config: ScriptComparisonConfig): string {
  const { operator, expected } = resolveScriptComparison(config);
  const subject = formatComparisonSubject(config);
  if (operatorTakesNoValue(operator)) {
    return subject;
  }
  if (expected === undefined) {
    // No `expected` means `compareScriptOutput` fell back to "the script exited
    // 0" whatever source and operator were configured, so print the rule that
    // actually ran — `stdout contains 0` would describe a comparison nobody made.
    return `exit code ${SCRIPT_OPERATOR_OPTIONS_META[DEFAULT_SCRIPT_OPERATOR].label.toLowerCase()} 0`;
  }
  return `${subject} ${expected}`;
}
