import React, { useState, useEffect } from "react";
import { DrawerRow } from "./DrawerRow";
import { CustomSelect } from "./CustomSelect";
import {
  COMPARE_SOURCE_LABELS,
  type EndConditionCompareSource,
} from "../../utils/endCondition";
import { CONDITION_ACTIONS, COMPARE_SOURCES } from "../../types/messages";
import type { SelectOption } from "./CustomSelect";
import { CodeMirrorEditor } from "@components/editor/CodeMirrorEditor";
import { getDictionaryUris } from "@utils/dictionaryUris";

const COMPARE_SOURCE_OPTIONS: SelectOption[] = (
  Object.values(COMPARE_SOURCES) as EndConditionCompareSource[]
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

/**
 * Shared script config shape for both endCondition and preCondition variants.
 * Kept loose so both contexts can pass their native store objects.
 */
export interface ScriptConditionValue {
  script?: string;
  returns?: string;
  compareSource?: string;
  timeout?: number;
  onPass?: string;
  onFail?: string;
  // endCondition-only fields
  maxRetries?: number;
  retryPrompt?: string;
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
 *   - Max Retries + Retry Prompt (when either onPass or onFail is "retry")
 *   - Resume Session on Retry checkbox
 *
 * preCondition variant uses "Continue / Skip Prompt / Stop Workflow" for action options.
 */
export const ScriptConditionEditor: React.FC<ScriptConditionEditorProps> = ({
  value,
  onChange,
  variant,
  narrow = false,
  disabled = false,
  idPrefix = variant,
  scriptLabel = "Script",
}) => {
  const v = value ?? {};
  const isScriptStep = variant === "scriptStep";
  const actionOptions =
    variant === "endCondition"
      ? END_CONDITION_ACTION_OPTIONS
      : variant === "preCondition"
        ? PRE_CONDITION_ACTION_OPTIONS
        : SCRIPT_STEP_ACTION_OPTIONS;

  const hasRetry =
    variant === "endCondition" &&
    (v.onPass === CONDITION_ACTIONS.RETRY ||
      v.onFail === CONDITION_ACTIONS.RETRY);

  // Local string state for timeout to prevent auto-reset when clearing.
  // scriptStep: empty string means "inherit from settings" (undefined); others default to 30000.
  const [timeoutInput, setTimeoutInput] = useState(
    v.timeout !== undefined ? String(v.timeout) : isScriptStep ? "" : "30000"
  );
  const [maxRetriesInput, setMaxRetriesInput] = useState(
    String(v.maxRetries ?? 1)
  );

  useEffect(() => {
    setTimeoutInput(
      v.timeout !== undefined ? String(v.timeout) : isScriptStep ? "" : "30000"
    );
    // isScriptStep is derived from the variant prop which doesn't change at runtime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.timeout]);

  useEffect(() => {
    setMaxRetriesInput(String(v.maxRetries ?? 1));
  }, [v.maxRetries]);

  const update = (patch: Partial<ScriptConditionValue>) =>
    onChange({ ...v, ...patch });

  const compareSource = (v.compareSource ??
    COMPARE_SOURCES.AUTO) as EndConditionCompareSource;
  const { affUri, dicUri } = getDictionaryUris();
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
        <input
          type="text"
          id={`${idPrefix}-script`}
          value={v.script ?? ""}
          onChange={(e) => update({ script: e.target.value })}
          placeholder="npm test"
          disabled={disabled}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
        />
      </div>

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
            onChange={(val) =>
              update({ compareSource: val as EndConditionCompareSource })
            }
            options={COMPARE_SOURCE_OPTIONS}
            disabled={disabled}
          />
          <span className="text-[10px] text-description-fg">
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
            value={v.returns ?? ""}
            onChange={(e) => update({ returns: e.target.value })}
            placeholder="true"
            disabled={disabled}
            className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
          />
          {returnsExitCodeHint && (
            <span className="text-[10px] text-description-fg">
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
          <div className="flex flex-col gap-1">
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
              onBlur={() => {
                const parsed = parseInt(timeoutInput);
                const val = isNaN(parsed) || parsed < 1000 ? 30000 : parsed;
                setTimeoutInput(String(val));
                update({ timeout: val });
              }}
              min={1000}
              max={300000}
              disabled={disabled}
              className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
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
              className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
            />
            <span className="text-[10px] text-description-fg">
              Use -1 for unlimited retries
            </span>
          </div>
        </DrawerRow>
      ) : (
        <div className="flex flex-col gap-1 w-1/2">
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
            onBlur={() => {
              if (isScriptStep) {
                // scriptStep: empty = inherit from settings (undefined); no minimum enforced
                if (timeoutInput.trim() === "") {
                  update({ timeout: undefined });
                } else {
                  const parsed = parseInt(timeoutInput);
                  const val = isNaN(parsed) ? undefined : parsed;
                  setTimeoutInput(val !== undefined ? String(val) : "");
                  update({ timeout: val });
                }
              } else {
                const parsed = parseInt(timeoutInput);
                const val = isNaN(parsed) || parsed < 1000 ? 30000 : parsed;
                setTimeoutInput(String(val));
                update({ timeout: val });
              }
            }}
            min={isScriptStep ? 0 : 1000}
            max={isScriptStep ? undefined : 300000}
            placeholder={isScriptStep ? "Default (from settings)" : undefined}
            disabled={disabled}
            className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
          />
        </div>
      )}

      {/* endCondition-only: retry fields (shown when retry is an action) */}
      {variant === "endCondition" && hasRetry && (
        <>
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
                "Validation failed: {stderr}\n\nPlease fix the issues."
              }
              affUri={affUri}
              dicUri={dicUri}
              readOnly={disabled}
              mode="endCondition"
              surface="input"
              minHeightClassName="min-h-[96px]"
              maxHeightClassName="max-h-[220px]"
              className={`overflow-hidden rounded border border-input-border bg-input-bg focus-within:border-focus-border ${disabled ? "opacity-50" : ""}`}
            />
            <span className="text-[10px] text-description-fg">
              Type {"{"} for retry placeholders like {"{stderr}"} and{" "}
              {"{stdout}"}.
            </span>
          </div>

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
    </div>
  );
};
