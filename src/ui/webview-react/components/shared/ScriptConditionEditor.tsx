import React, { useState, useEffect, useRef } from "react";
import { DrawerRow } from "./DrawerRow";
import { CustomSelect } from "./CustomSelect";
import { ActionButton } from "./ActionButton";
import {
  CONDITION_ACTIONS,
  COMPARE_SOURCES,
  COMPARE_SOURCE_LABELS,
  type CompareSource,
} from "../../types/messages";
import type { SelectOption } from "./CustomSelect";
import { CodeMirrorEditor } from "@components/editor/CodeMirrorEditor";
import { ScriptCommandEditor } from "./ScriptCommandEditor";
import { CreateScriptModal } from "./CreateScriptModal";
import { getDictionaryUris } from "@utils/dictionaryUris";
import { useSettingsStore } from "@store/settingsStore";
import {
  EXECUTION_MODE_HELP_TEXT,
  EXECUTION_MODE_OPTIONS,
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
  type EndConditionScriptType,
  type ExecutionMode,
} from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { notifyUser } from "@utils/notifyUser";
import { KeyValueMapEditor } from "./KeyValueMapEditor";

const COMPARE_SOURCE_OPTIONS: SelectOption[] = (
  Object.values(COMPARE_SOURCES) as CompareSource[]
).map((v) => ({ value: v, label: COMPARE_SOURCE_LABELS[v] }));

/** Action options for end condition (onPass/onFail) */
const END_CONDITION_ACTION_OPTIONS: SelectOption[] = [
  { value: CONDITION_ACTIONS.CONTINUE, label: "Continue" },
  { value: CONDITION_ACTIONS.RETRY, label: "Retry" },
  { value: CONDITION_ACTIONS.STOP_WORKFLOW, label: "Stop Workflow" },
];

/** Action options for pre-condition (onPass/onFail) */
const PRE_CONDITION_ACTION_OPTIONS: SelectOption[] = [
  { value: CONDITION_ACTIONS.CONTINUE, label: "Continue" },
  { value: CONDITION_ACTIONS.SKIP_PROMPT, label: "Skip Prompt" },
  { value: CONDITION_ACTIONS.STOP_WORKFLOW, label: "Stop Workflow" },
];

/** Action options for script step (onPass/onFail) */
const SCRIPT_STEP_ACTION_OPTIONS: SelectOption[] = [
  { value: CONDITION_ACTIONS.CONTINUE, label: "Continue" },
  { value: CONDITION_ACTIONS.STOP_WORKFLOW, label: "Stop Workflow" },
];

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
  returns?: string;
  compareSource?: string;
  timeout?: number;
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
  variant: "endCondition" | "preCondition" | "scriptStep";
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
}

/**
 * ScriptConditionEditor — shared UI for end condition and pre-condition configuration.
 *
 * Both variants render:
 *   - Script (full width)
 *   - On Pass + On Fail (side-by-side)
 *   - Compare Source + Expected Return (side-by-side)
 *   - Timeout (half-width)
 *
 * endCondition variant additionally renders:
 *   - Max Retries (when either onPass or onFail is "retry")
 *   - Pass Retry Prompt (when onPass is "retry")
 *   - Retry Prompt (when onFail is "retry")
 *   - Resume Session on Retry checkbox
 *
 * preCondition variant uses "Continue / Skip Prompt / Stop Workflow" for action options.
 *
 * scriptStep variant additionally renders an Execution Mode dropdown (paired with
 * Timeout) — interactive/headless/inherit for this step. Pre/end conditions never
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
}) => {
  const v = value ?? {};
  const actionOptions =
    variant === "endCondition"
      ? END_CONDITION_ACTION_OPTIONS
      : variant === "preCondition"
        ? PRE_CONDITION_ACTION_OPTIONS
        : SCRIPT_STEP_ACTION_OPTIONS;

  const hasPassRetry =
    variant === "endCondition" && v.onPass === CONDITION_ACTIONS.RETRY;
  const hasFailRetry =
    variant === "endCondition" && v.onFail === CONDITION_ACTIONS.RETRY;
  const hasRetry = hasPassRetry || hasFailRetry;

  // Local string state for text fields — committed on blur/Enter to avoid
  // flooding the undo stack with every keystroke.
  const [scriptInput, setScriptInput] = useState(v.script ?? "");
  const [returnsInput, setReturnsInput] = useState(v.returns ?? "");

  // Local string state for timeout to prevent auto-reset when clearing.
  // Empty string means "inherit from settings" (ctrlyoke.scriptTimeout) — timeout stays
  // undefined on the underlying value across all variants; the runtime (EndConditionEvaluator,
  // WorkflowExecutor) already falls back to ConfigurationUtils.getScriptTimeoutMs() whenever
  // timeout is unset, so there is no separate UI-level default to keep in sync.
  const [timeoutInput, setTimeoutInput] = useState(
    v.timeout !== undefined ? String(v.timeout) : ""
  );
  const [maxRetriesInput, setMaxRetriesInput] = useState(
    String(v.maxRetries ?? 1)
  );
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
    setReturnsInput(v.returns ?? "");
  }, [v.returns]);

  useEffect(() => {
    setTimeoutInput(v.timeout !== undefined ? String(v.timeout) : "");
  }, [v.timeout]);

  useEffect(() => {
    setMaxRetriesInput(String(v.maxRetries ?? 1));
  }, [v.maxRetries]);

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

  const update = (patch: Partial<ScriptConditionValue>) =>
    onChange({ ...v, ...patch });

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

  // Shared across variants: empty input inherits ctrlyoke.scriptTimeout; otherwise commit the
  // parsed number verbatim (no minimum/maximum substitution — those aren't enforced anywhere
  // downstream, so clamping here would just be another UI-invented magic number).
  const commitTimeout = () => {
    if (timeoutInput.trim() === "") {
      update({ timeout: undefined });
      return;
    }
    const parsed = parseInt(timeoutInput, 10);
    if (isNaN(parsed)) {
      setTimeoutInput(v.timeout !== undefined ? String(v.timeout) : "");
      return;
    }
    setTimeoutInput(String(parsed));
    update({ timeout: parsed });
  };

  const compareSource = (v.compareSource ??
    COMPARE_SOURCES.AUTO) as CompareSource;
  const { affUri, dicUri } = getDictionaryUris();

  // scriptStep-only: resolved inherited execution mode (workflow -> global settings),
  // used to label the "Inherit" option the same way PropertiesDrawer labels it for prompt steps.
  const resolvedExecutionMode = useSettingsStore(
    (s) => s.workflowProperties.executionMode ?? s.globalSettings.executionMode
  );
  const defaultExecutionModeLabel = `Inherit (${
    EXECUTION_MODE_OPTIONS.find(
      (option) => option.value === resolvedExecutionMode
    )?.label ?? resolvedExecutionMode
  })`;
  const compareSourceHint =
    compareSource === COMPARE_SOURCES.AUTO
      ? "'true'/'false' check exit code; other values compare stdout"
      : compareSource === COMPARE_SOURCES.STDOUT
        ? "Compares stdout text output (requires a clean exit)"
        : compareSource === COMPARE_SOURCES.STDERR
          ? "Compares stderr text output (exit code not checked)"
          : "Compares the numeric exit code directly (e.g. '0', '1')";

  // Shown under Expected Return when exit code semantics apply — clarifies the
  // counterintuitive shell convention: success=0, failure=non-zero.
  const returnsExitCodeHint =
    compareSource === COMPARE_SOURCES.AUTO ||
    compareSource === COMPARE_SOURCES.EXIT_CODE
      ? "Shell exit codes: true = 0 (success)  ·  false = non-zero (failure)"
      : null;

  return (
    <div className="space-y-3">
      {/* Script (full width) */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${idPrefix}-script`}
          className="text-xs font-medium text-foreground"
        >
          {scriptLabel}
        </label>
        <ScriptCommandEditor
          id={`${idPrefix}-script`}
          value={scriptInput}
          onChange={setScriptInput}
          onBlur={() => update({ script: scriptInput })}
          placeholder="npm test"
          disabled={disabled}
          className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
        />
      </div>

      {variant === "scriptStep" && (
        <KeyValueMapEditor
          label="Environment"
          ariaLabel={`${idPrefix}-env`}
          value={v.env ?? {}}
          onChange={(env) => update({ env })}
          allowSecretReferences
        />
      )}

      {variant === "endCondition" && (
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

      {/* Compare Source + Expected Return */}
      <DrawerRow narrow={narrow}>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${idPrefix}-compare-source`}
            className="text-xs font-medium text-foreground"
            title="Auto: 'true'/'false' check exit code (0=success); other values compare stdout. Stdout/Stderr: text match. Exit Code: numeric exit code directly."
          >
            Compare Source
          </label>
          <CustomSelect
            id={`${idPrefix}-compare-source`}
            value={compareSource}
            onChange={(val) => update({ compareSource: val as CompareSource })}
            options={COMPARE_SOURCE_OPTIONS}
            disabled={disabled}
          />
          <span className="text-xxs text-description-fg">
            {compareSourceHint}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${idPrefix}-returns`}
            className="text-xs font-medium text-foreground"
          >
            Expected Return
          </label>
          <input
            type="text"
            id={`${idPrefix}-returns`}
            value={returnsInput}
            onChange={(e) => setReturnsInput(e.target.value)}
            onBlur={(e) => update({ returns: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder="true"
            disabled={disabled}
            className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
          />
          {returnsExitCodeHint && (
            <span className="text-xxs text-description-fg">
              {returnsExitCodeHint}
            </span>
          )}
        </div>
      </DrawerRow>

      {/* On Pass + On Fail */}
      <DrawerRow narrow={narrow}>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${idPrefix}-on-pass`}
            className="text-xs font-medium text-foreground"
          >
            On Pass
          </label>
          <CustomSelect
            id={`${idPrefix}-on-pass`}
            value={v.onPass ?? CONDITION_ACTIONS.CONTINUE}
            onChange={(val) => update({ onPass: val })}
            options={actionOptions}
            disabled={disabled}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${idPrefix}-on-fail`}
            className="text-xs font-medium text-foreground"
          >
            On Fail
          </label>
          <CustomSelect
            id={`${idPrefix}-on-fail`}
            value={
              v.onFail ??
              (variant === "preCondition"
                ? CONDITION_ACTIONS.SKIP_PROMPT
                : CONDITION_ACTIONS.STOP_WORKFLOW)
            }
            onChange={(val) => update({ onFail: val })}
            options={actionOptions}
            disabled={disabled}
          />
        </div>
      </DrawerRow>

      {/* Timeout + Max Retries (Max Retries shares row with Timeout in wide view when retry is active) */}
      {variant === "endCondition" && hasRetry ? (
        <DrawerRow narrow={narrow}>
          <div className="flex flex-col gap-1 w-full">
            <label
              htmlFor={`${idPrefix}-timeout`}
              className="text-xs font-medium text-foreground"
            >
              Timeout (ms)
            </label>
            <input
              type="number"
              id={`${idPrefix}-timeout`}
              value={timeoutInput}
              onChange={(e) => setTimeoutInput(e.target.value)}
              onBlur={commitTimeout}
              min={0}
              placeholder="Default (from settings)"
              disabled={disabled}
              className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor={`${idPrefix}-max-retries`}
              className="text-xs font-medium text-foreground"
            >
              Max Retries
            </label>
            <input
              type="number"
              id={`${idPrefix}-max-retries`}
              value={maxRetriesInput}
              onChange={(e) => setMaxRetriesInput(e.target.value)}
              onBlur={() => {
                const parsed = parseInt(maxRetriesInput);
                const val = isNaN(parsed) ? 1 : parsed;
                setMaxRetriesInput(String(val));
                update({ maxRetries: val });
              }}
              min={-1}
              max={100}
              disabled={disabled}
              className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
            />
            <span className="text-xxs text-description-fg">
              Use -1 for unlimited retries
            </span>
          </div>
        </DrawerRow>
      ) : variant === "scriptStep" ? (
        <DrawerRow narrow={narrow}>
          <div className="flex flex-col gap-1 w-full">
            <label
              htmlFor={`${idPrefix}-timeout`}
              className="text-xs font-medium text-foreground"
            >
              Timeout (ms)
            </label>
            <input
              type="number"
              id={`${idPrefix}-timeout`}
              value={timeoutInput}
              onChange={(e) => setTimeoutInput(e.target.value)}
              onBlur={commitTimeout}
              min={0}
              placeholder="Default (from settings)"
              disabled={disabled}
              className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor={`${idPrefix}-execution-mode`}
              className="text-xs font-medium text-foreground"
              title={EXECUTION_MODE_HELP_TEXT}
            >
              Execution Mode
            </label>
            <CustomSelect
              id={`${idPrefix}-execution-mode`}
              value={v.executionMode ?? "default"}
              onChange={(val) =>
                update({
                  executionMode:
                    val === "default" ? undefined : (val as ExecutionMode),
                })
              }
              options={[
                { value: "default", label: defaultExecutionModeLabel },
                ...EXECUTION_MODE_OPTIONS,
              ]}
              disabled={disabled}
            />
          </div>
        </DrawerRow>
      ) : (
        <DrawerRow narrow={narrow}>
          <div className="flex flex-col gap-1 w-full">
            <label
              htmlFor={`${idPrefix}-timeout`}
              className="text-xs font-medium text-foreground"
            >
              Timeout (ms)
            </label>
            <input
              type="number"
              id={`${idPrefix}-timeout`}
              value={timeoutInput}
              onChange={(e) => setTimeoutInput(e.target.value)}
              onBlur={commitTimeout}
              min={0}
              placeholder="Default (from settings)"
              disabled={disabled}
              className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
            />
          </div>
        </DrawerRow>
      )}

      {/* endCondition-only: retry fields (shown when retry is an action) */}
      {variant === "endCondition" && hasRetry && (
        <>
          {hasPassRetry && (
            <div className="flex flex-col gap-1">
              <label
                htmlFor={`${idPrefix}-pass-retry-prompt`}
                className="text-xs font-medium text-foreground"
              >
                Pass Retry Prompt
              </label>
              <CodeMirrorEditor
                id={`${idPrefix}-pass-retry-prompt`}
                value={v.passRetryPrompt ?? ""}
                onChange={(passRetryPrompt) => update({ passRetryPrompt })}
                placeholder={
                  "Validation passed, but the condition still holds.\n\nContinue working until it fails."
                }
                affUri={affUri}
                dicUri={dicUri}
                readOnly={disabled}
                mode="endCondition"
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
                className="text-xs font-medium text-foreground"
              >
                Retry Prompt
              </label>
              <CodeMirrorEditor
                id={`${idPrefix}-retry-prompt`}
                value={v.retryPrompt ?? ""}
                onChange={(retryPrompt) => update({ retryPrompt })}
                placeholder={
                  "Validation failed: expected $endCondition:expected but got $endCondition:actual from $endCondition:compareSource\n\nPlease fix the issues."
                }
                affUri={affUri}
                dicUri={dicUri}
                readOnly={disabled}
                mode="endCondition"
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
              title="When enabled, retries continue in the same session. Uncheck to start a fresh session for each retry."
            >
              Resume Session on Retry
            </label>
          </div>
        </>
      )}
      <CreateScriptModal
        isOpen={variant === "endCondition" && createScriptModalOpen}
        onClose={() => setCreateScriptModalOpen(false)}
        onCreate={handleCreateScript}
        pending={creatingScript}
        idPrefix={`${idPrefix}-create-script`}
      />
    </div>
  );
};
