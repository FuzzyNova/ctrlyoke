import React, { useState, useEffect, useMemo, useRef } from "react";
import { DrawerRow } from "./DrawerRow";
import { CustomSelect } from "./CustomSelect";
import { LimitSelect } from "./LimitSelect";
import { ActionButton } from "./ActionButton";
import {
  CONDITION_ACTIONS,
  COMPARE_SOURCES,
  type CompareSource,
} from "../../types/messages";
import {
  DEFAULT_COMPARE_SOURCE,
  DEFAULT_SCRIPT_OPERATOR,
  SCRIPT_OPERATORS,
  type ScriptOperator,
} from "@root/types/DashboardConstants";
import {
  describeComparison,
  describeIncompleteComparison,
  isComparisonIncomplete,
  operatorIsNumeric,
  operatorTakesNoValue,
  operatorUsesCase,
} from "@root/utils/ScriptComparison";
import { FieldDiagnostic } from "./FieldDiagnostic";
import {
  fieldValidationBorderClass,
  type FieldDiagnostic as FieldDiagnosticItem,
} from "@utils/fieldValidation";
import { CodeMirrorEditor } from "@components/editor/CodeMirrorEditor";
import { ScriptCommandEditor } from "./ScriptCommandEditor";
import { CreateScriptModal } from "./CreateScriptModal";
import { getDictionaryUris } from "@utils/dictionaryUris";
import { useSettingsStore } from "@store/settingsStore";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CUSTOM_SHELL_OPTION,
  INHERIT_DEFAULT_OPTION,
  LIMIT_SELECTION_VALUES,
  KEYBOARD_KEYS,
  EXECUTION_MODE_HELP_TEXT,
  PROMPT_PROPERTIES,
  SCRIPT_CONDITION_VARIANTS,
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
  type EndConditionScriptType,
  type ExecutionMode,
} from "@root/types/DashboardConstants";
import {
  COMPARE_SOURCE_OPTIONS_META,
  CONDITION_ACTION_OPTIONS_META,
  EXECUTION_MODE_OPTIONS_META,
  SCRIPT_OPERATOR_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";
import { isUnlimited } from "@root/utils/LimitUtils";
import {
  resolveShellKind,
  getShellInvocationError,
} from "@root/utils/ShellCatalog";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { notifyUser } from "@utils/notifyUser";
import { detectPlatform } from "@utils/platform";
import { shellWarning } from "@utils/dropdownValidation";
import { KeyValueRowsEditor } from "./KeyValueRowsEditor";
import {
  buildShellOptions,
  customShellPathPlaceholder,
  shellSelectValue,
  usesCustomShellPath,
} from "./shellSelectOptions";

let createScriptRequestCounter = 0;

function nextCreateScriptRequestId(): string {
  createScriptRequestCounter += 1;
  return `end-condition-script-${Date.now()}-${createScriptRequestCounter}`;
}

function scriptFileName(scriptPath: string): string {
  return scriptPath.split(/[\\/]/).pop() || scriptPath;
}

/**
 * Shared script config shape for both endCondition and preCondition variants.
 * Kept loose so both contexts can pass their native store objects.
 */
export interface ScriptConditionValue {
  script?: string;
  env?: Record<string, string>;
  expected?: string;
  operator?: string;
  ignoreCase?: boolean;
  compareSource?: string;
  timeoutSec?: number;
  shell?: string;
  onPass?: string;
  onFail?: string;
  // scriptStep-only field — inherits from workflow/settings when undefined.
  // Pre/end conditions always run headless and never expose this.
  executionMode?: ExecutionMode;
  // endCondition-only fields
  maxRetries?: number;
  retryPrompt?: string;
  passRetryPrompt?: string;
  resumeSessionOnRetry?: boolean;
}

interface ScriptConditionEditorProps {
  /** Current value (null = enabled but no script configured, undefined = not enabled) */
  value: ScriptConditionValue | null | undefined;
  /** Called whenever any field changes */
  onChange: (updated: ScriptConditionValue) => void;
  /**
   * "endCondition" shows retry fields;
   * "preCondition" shows skip-prompt action options;
   * "scriptStep" shows continue/stopWorkflow only with optional timeout
   */
  variant:
    | typeof PROMPT_PROPERTIES.END_CONDITION
    | typeof PROMPT_PROPERTIES.PRE_CONDITION
    | typeof SCRIPT_CONDITION_VARIANTS.SCRIPT_STEP;
  /** Narrow layout mode (stacks columns vertically) */
  narrow?: boolean;
  /** Disables all inputs */
  disabled?: boolean;
  /** HTML id prefix for inputs (for accessibility) */
  idPrefix?: string;
  /** Label for the script input field (defaults to "Script") */
  scriptLabel?: string;
  /** Whether the edited step has an effective pre-condition configured. */
  hasPreCondition?: boolean;
  /** File-relative schema path for this script condition (e.g. endCondition). */
  schemaPath?: string;
}

/**
 * ScriptConditionEditor — shared UI for end condition and pre-condition configuration.
 *
 * Both variants render:
 *   - Script (full width)
 *   - On Pass + On Fail (side-by-side)
 *   - Compare Source + Expected Return (side-by-side)
 *   - Timeout + Shell (side-by-side)
 *
 * endCondition variant additionally renders:
 *   - Max Retries (when either onPass or onFail is "retry")
 *   - Pass Retry Prompt (when onPass is "retry")
 *   - Retry Prompt (when onFail is "retry")
 *   - Resume Session on Retry checkbox
 *
 * preCondition variant uses "Continue / Skip Prompt / Stop Workflow" for action options.
 *
 * scriptStep variant additionally renders an Execution Mode dropdown after the shared
 * Timeout + Shell row — interactive/headless/inherit for this step. Pre/end conditions never
 * get this control; they always run headless (see PER_STEP_EXECUTION_MODE_PLAN.md).
 */
export const ScriptConditionEditor: React.FC<ScriptConditionEditorProps> = ({
  value,
  onChange,
  variant,
  narrow = false,
  disabled = false,
  idPrefix = variant,
  scriptLabel = "Script",
  hasPreCondition = false,
  schemaPath = variant === SCRIPT_CONDITION_VARIANTS.SCRIPT_STEP
    ? "steps[]"
    : variant,
}) => {
  const v = value ?? {};
  const compareSourcePath = `${schemaPath}.compareSource`;
  const operatorPath = `${schemaPath}.operator`;
  const compareSourceOptions = toSelectOptions(
    COMPARE_SOURCE_OPTIONS_META,
    compareSourcePath
  );
  const operatorOptions = toSelectOptions(
    SCRIPT_OPERATOR_OPTIONS_META,
    operatorPath
  );
  const actionOptions =
    variant === PROMPT_PROPERTIES.END_CONDITION
      ? [
          CONDITION_ACTIONS.CONTINUE,
          CONDITION_ACTIONS.RETRY,
          CONDITION_ACTIONS.STOP_WORKFLOW,
        ]
      : variant === PROMPT_PROPERTIES.PRE_CONDITION
        ? [
            CONDITION_ACTIONS.CONTINUE,
            CONDITION_ACTIONS.SKIP_PROMPT,
            CONDITION_ACTIONS.STOP_WORKFLOW,
          ]
        : [CONDITION_ACTIONS.CONTINUE, CONDITION_ACTIONS.STOP_WORKFLOW];
  const actionOptionsFor = (property: "onPass" | "onFail") =>
    actionOptions.map((action) => ({
      ...CONDITION_ACTION_OPTIONS_META[action],
      schemaPath: `${schemaPath}.${property}`,
    }));

  const hasPassRetry =
    variant === PROMPT_PROPERTIES.END_CONDITION &&
    v.onPass === CONDITION_ACTIONS.RETRY;
  const hasFailRetry =
    variant === PROMPT_PROPERTIES.END_CONDITION &&
    v.onFail === CONDITION_ACTIONS.RETRY;
  const hasRetry = hasPassRetry || hasFailRetry;

  // Local string state for text fields — committed on blur/Enter to avoid
  // flooding the undo stack with every keystroke.
  const [scriptInput, setScriptInput] = useState(v.script ?? "");
  const [expectedInput, setExpectedInput] = useState(v.expected ?? "");
  const [shellInput, setShellInput] = useState(v.shell ?? "");

  // Local string state for timeout to prevent auto-reset when clearing.
  // Empty string means "inherit from settings" (execution.scriptTimeout) — timeout stays
  // undefined on the underlying value across all variants; the runtime (EndConditionEvaluator,
  // WorkflowExecutor) already falls back to ConfigurationUtils.getScriptTimeoutMs() whenever
  // timeout is unset, so there is no separate UI-level default to keep in sync.
  const [timeoutInput, setTimeoutInput] = useState(
    v.timeoutSec !== undefined ? String(v.timeoutSec) : ""
  );
  const [passRetryPromptInput, setPassRetryPromptInput] = useState(
    v.passRetryPrompt ?? ""
  );
  const [retryPromptInput, setRetryPromptInput] = useState(v.retryPrompt ?? "");
  const [createScriptModalOpen, setCreateScriptModalOpen] = useState(false);
  const [creatingScript, setCreatingScript] = useState(false);
  const pendingCreateScriptRequest = useRef<string | null>(null);
  const currentValueRef = useRef(value);

  useEffect(() => {
    currentValueRef.current = value;
  }, [value]);

  useEffect(() => {
    setScriptInput(v.script ?? "");
  }, [v.script]);

  useEffect(() => {
    setExpectedInput(v.expected ?? "");
  }, [v.expected]);

  useEffect(() => {
    setShellInput(v.shell ?? "");
  }, [v.shell]);

  useEffect(() => {
    setTimeoutInput(v.timeoutSec !== undefined ? String(v.timeoutSec) : "");
  }, [v.timeoutSec]);

  useEffect(() => {
    setPassRetryPromptInput(v.passRetryPrompt ?? "");
  }, [v.passRetryPrompt]);

  useEffect(() => {
    setRetryPromptInput(v.retryPrompt ?? "");
  }, [v.retryPrompt]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (
        message?.requestId !== pendingCreateScriptRequest.current ||
        (message.type !== MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATED &&
          message.type !== MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATION_FAILED)
      ) {
        return;
      }

      pendingCreateScriptRequest.current = null;
      setCreatingScript(false);

      if (
        message.type === MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATED &&
        typeof message.scriptPath === "string"
      ) {
        setScriptInput(message.scriptPath);
        setCreateScriptModalOpen(false);
        onChange({
          ...(currentValueRef.current ?? {}),
          script: message.scriptPath,
        });
        notifyUser(
          `Created end condition script: ${scriptFileName(message.scriptPath)}`,
          USER_FEEDBACK_SEVERITY.SUCCESS
        );
        return;
      }

      notifyUser(
        message.error || "Failed to create end condition script",
        USER_FEEDBACK_SEVERITY.ERROR
      );
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onChange]);

  const update = (patch: Partial<ScriptConditionValue>) => {
    const next = { ...v, ...patch };
    onChange(next);
  };

  const handleEnvironmentChange = (env: Record<string, string>) => {
    // An empty map means inherit. The explicit undefined is intentional: it
    // lets a nested UPDATE_PROMPT merge clear an existing env key, while JSON
    // persistence omits the key instead of writing env: {}.
    update({
      env: Object.keys(env).length > 0 ? env : undefined,
    });
  };

  const handleCreateScript = (
    scriptType: EndConditionScriptType,
    scriptName: string
  ) => {
    const requestId = nextCreateScriptRequestId();
    pendingCreateScriptRequest.current = requestId;
    setCreatingScript(true);
    getVsCodeApi().postMessage({
      type: MESSAGE_TYPES.CREATE_END_CONDITION_SCRIPT,
      requestId,
      scriptType,
      scriptName,
    });
  };

  // Shared across variants: empty input inherits execution.scriptTimeout; otherwise commit the
  // parsed number verbatim (no minimum/maximum substitution — those aren't enforced anywhere
  // downstream, so clamping here would just be another UI-invented magic number).
  const commitTimeout = () => {
    if (timeoutInput.trim() === "") {
      update({ timeoutSec: undefined });
      return;
    }
    const parsed = parseFloat(timeoutInput);
    if (isNaN(parsed)) {
      setTimeoutInput(v.timeoutSec !== undefined ? String(v.timeoutSec) : "");
      return;
    }
    setTimeoutInput(String(parsed));
    update({ timeoutSec: parsed });
  };

  const commitShell = () => {
    update({ shell: shellInput.trim() === "" ? undefined : shellInput });
  };

  // The dropdown lists the shells this platform normally has, but a workflow
  // file travels: a step pinned to `zsh` on macOS stays selected (and warned
  // about) when the same file is opened on Windows rather than being dropped.
  const platform = useMemo(() => detectPlatform(), []);
  const [customShellPath, setCustomShellPath] = useState(() =>
    usesCustomShellPath(v.shell)
  );

  useEffect(() => {
    setCustomShellPath(usesCustomShellPath(v.shell));
  }, [v.shell]);

  const shellOptions = useMemo(
    () =>
      buildShellOptions(v.shell, platform).map((option) =>
        option.value === INHERIT_DEFAULT_OPTION
          ? { ...option, pseudo: { writes: "omit shell" } }
          : option.value === CUSTOM_SHELL_OPTION
            ? { ...option, pseudo: { writes: "shell: <custom path>" } }
            : option
      ),
    [v.shell, platform]
  );

  const handleShellSelect = (selected: string) => {
    if (selected === CUSTOM_SHELL_OPTION) {
      // Keep the current value as the starting point for the path input.
      setCustomShellPath(true);
      return;
    }
    setCustomShellPath(false);
    update({
      shell: selected === INHERIT_DEFAULT_OPTION ? undefined : selected,
    });
  };

  // A multi-line script under cmd cannot run at all, so it outranks the softer
  // "this platform probably lacks that shell" notice and is painted as an error.
  const shellInvocationError = v.shell
    ? getShellInvocationError(v.script ?? "", resolveShellKind(v.shell))
    : undefined;
  const shellValidation =
    shellInvocationError ?? shellWarning(v.shell, platform) ?? undefined;
  const shellValidationSeverity = shellInvocationError
    ? COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
    : COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING;

  const compareSource = (v.compareSource ??
    DEFAULT_COMPARE_SOURCE) as CompareSource;
  const operator = (v.operator ?? DEFAULT_SCRIPT_OPERATOR) as ScriptOperator;
  const showExpected = !operatorTakesNoValue(operator);
  const showIgnoreCase = operatorUsesCase(operator);

  /**
   * Switching to an operator that ignores case (or ignores `expected`) clears
   * the field it no longer shows. Hiding a control without clearing its value
   * leaves an invisible override serialized onto the step.
   */
  const handleOperatorChange = (selected: string) => {
    const nextOperator = selected as ScriptOperator;
    const patch: Partial<ScriptConditionValue> = {
      operator:
        nextOperator === DEFAULT_SCRIPT_OPERATOR ? undefined : nextOperator,
    };
    if (!operatorUsesCase(nextOperator)) {
      patch.ignoreCase = undefined;
    }
    if (operatorTakesNoValue(nextOperator)) {
      patch.expected = undefined;
      setExpectedInput("");
    }
    update(patch);
  };
  const { affUri, dicUri } = getDictionaryUris();

  // scriptStep-only: resolved inherited execution mode (workflow -> global settings),
  // used to label the "Inherit" option the same way PropertiesDrawer labels it for prompt steps.
  const resolvedExecutionMode = useSettingsStore(
    (s) => s.workflowProperties.executionMode ?? s.globalSettings.executionMode
  );
  const resolvedMaxRetries = useSettingsStore(
    (s) => s.globalSettings.defaultEndCondition?.maxRetries ?? 1
  );
  const inheritMaxRetriesLabel = isUnlimited(resolvedMaxRetries)
    ? "Unlimited"
    : String(resolvedMaxRetries);
  const allowMaxRetriesInherit = !schemaPath.startsWith("defaults.");
  const defaultExecutionModeLabel = `Inherit (${
    EXECUTION_MODE_OPTIONS_META[resolvedExecutionMode]?.label ??
    resolvedExecutionMode
  })`;
  // One generated sentence, shared with the execution preview and the CLI
  // verdict, so all three describe a condition the same way.
  // The unset value renders its own default as a placeholder, so the author
  // sees what will run without the workflow file carrying the field. The
  // operator decides the *shape* of the value (a regex, a number, a literal),
  // so it outranks the source: `exitCode matches` still takes a pattern, and a
  // placeholder of `0` there would read as a literal exit code.
  const expectedPlaceholder =
    operator === SCRIPT_OPERATORS.MATCHES
      ? compareSource === COMPARE_SOURCES.EXIT_CODE
        ? "^0$"
        : "^\\d+ passing, 0 failing$"
      : operatorIsNumeric(operator) ||
          compareSource === COMPARE_SOURCES.EXIT_CODE
        ? "0"
        : "0 failing";

  const comparisonHint = describeComparison({
    compareSource,
    operator,
    expected: showExpected ? (v.expected ?? undefined) : undefined,
    ignoreCase: v.ignoreCase,
  });

  /**
   * A stated comparison with no value to compare against is authored, saved,
   * and run — the runtime falls back to "the script exited 0" and the stated
   * source/operator is simply never applied. That is silent enough to be worth
   * flagging, but it is not an error: the schema accepts it, the workflow
   * loads, and the run proceeds, consistent with how every other
   * environment-dependent mismatch is surfaced.
   */
  const comparisonDiagnostics: FieldDiagnosticItem[] = isComparisonIncomplete({
    compareSource,
    operator,
    expected: v.expected,
  })
    ? [
        {
          severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
          message: describeIncompleteComparison({ compareSource, operator }),
        },
      ]
    : [];

  return (
    <div className="space-y-3">
      {/* Script (full width) */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${idPrefix}-script`}
          className="text-xs font-medium text-foreground"
          title={schemaTitle(`${schemaPath}.script`)}
        >
          {scriptLabel}
        </label>
        <ScriptCommandEditor
          id={`${idPrefix}-script`}
          aria-label={schemaAriaLabel(scriptLabel, `${schemaPath}.script`)}
          value={scriptInput}
          onChange={setScriptInput}
          onBlur={() => update({ script: scriptInput })}
          multiline
          placeholder="npm test"
          disabled={disabled}
          className="w-full bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
        />
      </div>

      {/* Every variant runs a process, so all three author `env`. */}
      <KeyValueRowsEditor
        id={`${idPrefix}-env`}
        label="Environment"
        ariaLabel={`${idPrefix}-env`}
        schemaPath={`${schemaPath}.env`}
        value={v.env ?? {}}
        onChange={handleEnvironmentChange}
        keyKind="env"
        entryNoun="environment variable"
        allowSecretReferences
        disabled={disabled}
      />

      {variant === PROMPT_PROPERTIES.END_CONDITION && (
        <DrawerRow narrow={narrow}>
          <div className="flex items-end w-full">
            <ActionButton
              label="Create New Script"
              icon="new-file"
              onClick={() => setCreateScriptModalOpen(true)}
              disabled={disabled || creatingScript}
              className="w-full"
            />
          </div>
        </DrawerRow>
      )}

      {/* Pass when: compare source + operator + expected, read as one sentence. */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-foreground">Pass when</span>
        <div
          className={`flex gap-2 ${narrow ? "flex-col" : "flex-row items-start"}`}
        >
          <CustomSelect
            id={`${idPrefix}-compare-source`}
            value={compareSource}
            onChange={(val) => update({ compareSource: val as CompareSource })}
            options={compareSourceOptions}
            disabled={disabled}
            triggerAriaLabel="Compare source"
            schemaPath={compareSourcePath}
            className={narrow ? "w-full" : "flex-1 min-w-0"}
          />
          <CustomSelect
            id={`${idPrefix}-operator`}
            value={operator}
            onChange={handleOperatorChange}
            options={operatorOptions}
            disabled={disabled}
            triggerAriaLabel="Comparison operator"
            schemaPath={operatorPath}
            className={narrow ? "w-full" : "flex-1 min-w-0"}
          />
          {showExpected && (
            <input
              type="text"
              id={`${idPrefix}-expected`}
              title={schemaTitle(`${schemaPath}.expected`)}
              aria-label={schemaAriaLabel(
                "Expected value",
                `${schemaPath}.expected`
              )}
              value={expectedInput}
              onChange={(e) => setExpectedInput(e.target.value)}
              onBlur={(e) =>
                update({
                  expected:
                    e.target.value.trim() === "" ? undefined : e.target.value,
                })
              }
              onKeyDown={(e) => {
                if (e.key === KEYBOARD_KEYS.ENTER) e.currentTarget.blur();
              }}
              placeholder={expectedPlaceholder}
              disabled={disabled}
              aria-describedby={
                comparisonDiagnostics.length > 0
                  ? `${idPrefix}-expected-diagnostic`
                  : undefined
              }
              className={`px-2 py-1 text-sm bg-input-bg text-input-fg border ${fieldValidationBorderClass(
                comparisonDiagnostics
              )} rounded focus:outline-none focus:border-focus-border disabled:opacity-50 ${
                narrow ? "w-full" : "flex-1 min-w-0"
              }`}
            />
          )}
        </div>
        <span className="text-xxs text-description-fg">{comparisonHint}</span>
        <FieldDiagnostic
          id={`${idPrefix}-expected-diagnostic`}
          diagnostics={comparisonDiagnostics}
        />
        {showIgnoreCase && (
          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id={`${idPrefix}-ignore-case`}
              aria-label={schemaAriaLabel(
                "Ignore case",
                `${schemaPath}.ignoreCase`
              )}
              title={schemaTitle(
                `${schemaPath}.ignoreCase`,
                undefined,
                "Compare text without regard to letter case. Does not apply to numeric, regex, or emptiness operators."
              )}
              checked={v.ignoreCase ?? false}
              onChange={(e) =>
                update({ ignoreCase: e.target.checked ? true : undefined })
              }
              disabled={disabled}
              className="w-4 h-4 accent-focus-border cursor-pointer"
            />
            <label
              htmlFor={`${idPrefix}-ignore-case`}
              className="text-xs font-medium text-foreground cursor-pointer"
            >
              Ignore case
            </label>
          </div>
        )}
      </div>

      {/* On Pass + On Fail */}
      <DrawerRow narrow={narrow}>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${idPrefix}-on-pass`}
            className="text-xs font-medium text-foreground"
            title={schemaTitle(`${schemaPath}.onPass`)}
          >
            On Pass
          </label>
          <CustomSelect
            id={`${idPrefix}-on-pass`}
            value={v.onPass ?? CONDITION_ACTIONS.CONTINUE}
            onChange={(val) => update({ onPass: val })}
            options={actionOptionsFor("onPass")}
            disabled={disabled}
            schemaPath={`${schemaPath}.onPass`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${idPrefix}-on-fail`}
            className="text-xs font-medium text-foreground"
            title={schemaTitle(`${schemaPath}.onFail`)}
          >
            On Fail
          </label>
          <CustomSelect
            id={`${idPrefix}-on-fail`}
            value={
              v.onFail ??
              (variant === PROMPT_PROPERTIES.PRE_CONDITION
                ? CONDITION_ACTIONS.SKIP_PROMPT
                : CONDITION_ACTIONS.STOP_WORKFLOW)
            }
            onChange={(val) => update({ onFail: val })}
            options={actionOptionsFor("onFail")}
            disabled={disabled}
            schemaPath={`${schemaPath}.onFail`}
          />
        </div>
      </DrawerRow>

      {/* Timeout + Shell — shell applies to every script variant. */}
      <DrawerRow narrow={narrow}>
        <div className="flex flex-col gap-1 w-full">
          <label
            htmlFor={`${idPrefix}-timeout`}
            className="text-xs font-medium text-foreground"
            title={schemaTitle(`${schemaPath}.timeoutSec`)}
          >
            Timeout (s)
          </label>
          <input
            type="number"
            id={`${idPrefix}-timeout`}
            aria-label={schemaAriaLabel(
              "Timeout (s)",
              `${schemaPath}.timeoutSec`
            )}
            title={schemaTitle(`${schemaPath}.timeoutSec`)}
            value={timeoutInput}
            onChange={(e) => setTimeoutInput(e.target.value)}
            onBlur={commitTimeout}
            min={0.001}
            step="any"
            placeholder="Default (from settings)"
            disabled={disabled}
            className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1 w-full">
          <label
            htmlFor={`${idPrefix}-shell`}
            className="text-xs font-medium text-foreground"
            title={schemaTitle(
              `${schemaPath}.shell`,
              undefined,
              "Pins the interpreter for this script's inline text. Script files with a known extension (.ps1, .sh) always use their own interpreter."
            )}
            aria-label={schemaAriaLabel("Shell", `${schemaPath}.shell`)}
          >
            Shell
          </label>
          <CustomSelect
            id={`${idPrefix}-shell`}
            value={shellSelectValue(v.shell, customShellPath)}
            onChange={handleShellSelect}
            options={shellOptions}
            schemaPath={`${schemaPath}.shell`}
            disabled={disabled}
            warning={shellValidation}
            warningSeverity={shellValidationSeverity}
            warningId={`${idPrefix}-shell-warning`}
            triggerAriaLabel="Shell"
          />
        </div>
      </DrawerRow>

      {/* Free-text escape hatch for an interpreter the catalog doesn't know. */}
      {customShellPath && (
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${idPrefix}-shell-path`}
            className="text-xs font-medium text-foreground"
          >
            Custom shell path
          </label>
          <input
            type="text"
            id={`${idPrefix}-shell-path`}
            aria-label={schemaAriaLabel(
              "Custom shell path",
              `${schemaPath}.shell`
            )}
            title={schemaTitle(`${schemaPath}.shell`)}
            value={shellInput}
            onChange={(e) => setShellInput(e.target.value)}
            onBlur={commitShell}
            onKeyDown={(e) => {
              if (e.key === KEYBOARD_KEYS.ENTER) e.currentTarget.blur();
            }}
            placeholder={customShellPathPlaceholder(platform)}
            disabled={disabled}
            className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
          />
          <span className="text-xxs text-description-fg">
            Machine-specific paths do not travel with a shared workflow — prefer
            a bare shell name where one fits.
          </span>
        </div>
      )}

      {/* Variant-specific fields that follow the shared timeout/shell row. */}
      {variant === PROMPT_PROPERTIES.END_CONDITION && hasRetry ? (
        <DrawerRow narrow={narrow}>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground">
              Max Retries
            </span>
            <LimitSelect
              id={`${idPrefix}-max-retries`}
              label="Max Retries"
              path={`${schemaPath}.maxRetries`}
              value={v.maxRetries}
              onChange={(maxRetries) => update({ maxRetries })}
              mode={LIMIT_SELECTION_VALUES.UNLIMITED}
              min={0}
              max={100}
              customFallback={
                v.maxRetries === undefined
                  ? isUnlimited(resolvedMaxRetries)
                    ? 100
                    : resolvedMaxRetries
                  : isUnlimited(v.maxRetries)
                    ? 100
                    : v.maxRetries
              }
              inheritLabel={
                allowMaxRetriesInherit ? inheritMaxRetriesLabel : undefined
              }
              disabled={disabled}
            />
          </div>
        </DrawerRow>
      ) : variant === SCRIPT_CONDITION_VARIANTS.SCRIPT_STEP ? (
        <DrawerRow narrow={narrow}>
          <div className="flex flex-col gap-1">
            <label
              htmlFor={`${idPrefix}-execution-mode`}
              className="text-xs font-medium text-foreground"
              title={schemaTitle(
                `${schemaPath}.executionMode`,
                undefined,
                EXECUTION_MODE_HELP_TEXT
              )}
              aria-label={schemaAriaLabel(
                "Execution Mode",
                `${schemaPath}.executionMode`
              )}
            >
              Execution Mode
            </label>
            <CustomSelect
              id={`${idPrefix}-execution-mode`}
              value={v.executionMode ?? INHERIT_DEFAULT_OPTION}
              onChange={(val) =>
                update({
                  executionMode:
                    val === INHERIT_DEFAULT_OPTION
                      ? undefined
                      : (val as ExecutionMode),
                })
              }
              options={[
                {
                  value: INHERIT_DEFAULT_OPTION,
                  label: defaultExecutionModeLabel,
                  pseudo: { writes: "omit executionMode" },
                },
                ...toSelectOptions(
                  EXECUTION_MODE_OPTIONS_META,
                  `${schemaPath}.executionMode`
                ),
              ]}
              disabled={disabled}
              schemaPath={`${schemaPath}.executionMode`}
              triggerAriaLabel="Execution Mode"
            />
          </div>
        </DrawerRow>
      ) : null}

      {/* endCondition-only: retry fields (shown when retry is an action) */}
      {variant === PROMPT_PROPERTIES.END_CONDITION && hasRetry && (
        <>
          {hasPassRetry && (
            <div className="flex flex-col gap-1">
              <label
                htmlFor={`${idPrefix}-pass-retry-prompt`}
                title={schemaTitle(`${schemaPath}.passRetryPrompt`)}
                className="text-xs font-medium text-foreground"
              >
                Pass Retry Prompt
              </label>
              <CodeMirrorEditor
                id={`${idPrefix}-pass-retry-prompt`}
                value={passRetryPromptInput}
                onChange={setPassRetryPromptInput}
                onBlur={() => update({ passRetryPrompt: passRetryPromptInput })}
                placeholder={
                  "Validation passed, but the condition still holds.\n\nContinue working until it fails."
                }
                affUri={affUri}
                dicUri={dicUri}
                readOnly={disabled}
                mode={PROMPT_PROPERTIES.END_CONDITION}
                surface="input"
                hasPreCondition={hasPreCondition}
                minHeightClassName="min-h-[96px]"
                maxHeightClassName="max-h-[220px]"
                className={`overflow-hidden rounded border border-input-border bg-input-bg focus-within:border-focus-border ${disabled ? "opacity-50" : ""}`}
              />
              <span className="text-xxs text-description-fg">
                Type $ for condition-output references like{" "}
                {"$preCondition:stdout"} and {"$endCondition:stdout"}.
              </span>
            </div>
          )}

          {hasFailRetry && (
            <div className="flex flex-col gap-1">
              <label
                htmlFor={`${idPrefix}-retry-prompt`}
                title={schemaTitle(`${schemaPath}.retryPrompt`)}
                className="text-xs font-medium text-foreground"
              >
                Retry Prompt
              </label>
              <CodeMirrorEditor
                id={`${idPrefix}-retry-prompt`}
                value={retryPromptInput}
                onChange={setRetryPromptInput}
                onBlur={() => update({ retryPrompt: retryPromptInput })}
                placeholder={
                  "Validation failed: expected $endCondition:expected but got $endCondition:actual from $endCondition:compareSource\n\nPlease fix the issues."
                }
                affUri={affUri}
                dicUri={dicUri}
                readOnly={disabled}
                mode={PROMPT_PROPERTIES.END_CONDITION}
                surface="input"
                hasPreCondition={hasPreCondition}
                minHeightClassName="min-h-[96px]"
                maxHeightClassName="max-h-[220px]"
                className={`overflow-hidden rounded border border-input-border bg-input-bg focus-within:border-focus-border ${disabled ? "opacity-50" : ""}`}
              />
              <span className="text-xxs text-description-fg">
                Type $ for condition-output references like{" "}
                {"$preCondition:stderr"} and {"$endCondition:stdout"}.
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`${idPrefix}-resume-session-on-retry`}
              aria-label={schemaAriaLabel(
                "Resume Session on Retry",
                `${schemaPath}.resumeSessionOnRetry`
              )}
              title={schemaTitle(
                `${schemaPath}.resumeSessionOnRetry`,
                undefined,
                "When enabled, retries continue in the same session. Uncheck to start a fresh session for each retry."
              )}
              checked={v.resumeSessionOnRetry ?? true}
              onChange={(e) =>
                update({ resumeSessionOnRetry: e.target.checked })
              }
              disabled={disabled}
              className="w-4 h-4 accent-focus-border cursor-pointer"
            />
            <label
              htmlFor={`${idPrefix}-resume-session-on-retry`}
              className="text-xs font-medium text-foreground cursor-pointer"
              title={schemaTitle(
                `${schemaPath}.resumeSessionOnRetry`,
                undefined,
                "When enabled, retries continue in the same session. Uncheck to start a fresh session for each retry."
              )}
            >
              Resume Session on Retry
            </label>
          </div>
        </>
      )}
      <CreateScriptModal
        isOpen={
          variant === PROMPT_PROPERTIES.END_CONDITION && createScriptModalOpen
        }
        onClose={() => setCreateScriptModalOpen(false)}
        onCreate={handleCreateScript}
        pending={creatingScript}
        idPrefix={`${idPrefix}-create-script`}
      />
    </div>
  );
};
