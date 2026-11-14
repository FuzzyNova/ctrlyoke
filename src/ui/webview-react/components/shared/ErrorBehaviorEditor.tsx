import { useEffect, useMemo, useState } from "react";
import { CustomSelect } from "./CustomSelect";
import type { ErrorBehavior } from "@root/types/CtrlYokeTypes";
import {
  DEFAULT_ERROR_BEHAVIOR_RETRIES,
  ERROR_BEHAVIOR_ACTIONS,
  isErrorBehaviorRetry,
} from "@root/types/DashboardConstants";
import {
  ERROR_BEHAVIOR_ACTION_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";
import {
  asAuthoredValue,
  isWorkflowVariablePlaceholder,
  parseNumberOrVariable,
} from "@utils/wholeValueVariables";
import { WorkflowVariableValue } from "./WorkflowVariableValue";

const DEFAULT_ERROR_BEHAVIOR: ErrorBehavior = {
  onError: ERROR_BEHAVIOR_ACTIONS.STOP_WORKFLOW,
};

function normalizeErrorBehavior(value: ErrorBehavior | null | undefined) {
  return value ?? DEFAULT_ERROR_BEHAVIOR;
}

function applyActionDefaults(
  current: ErrorBehavior,
  onError: ErrorBehavior["onError"]
): ErrorBehavior {
  if (!isErrorBehaviorRetry(onError)) {
    return { onError };
  }

  return {
    onError,
    maxRetries: current.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES,
    ...(current.retryDelaySec !== undefined && {
      retryDelaySec: current.retryDelaySec,
    }),
  };
}

interface ErrorBehaviorEditorProps {
  value: ErrorBehavior | null | undefined;
  onChange: (value: ErrorBehavior) => void;
  disabled?: boolean;
  idPrefix?: string;
  schemaPath?: string;
  /**
   * Clears an `onError` authored as a `{{name}}` placeholder. Defaults to the
   * built-in stop action; an inheriting caller removes the override instead.
   */
  onClearVariable?: () => void;
}

export function ErrorBehaviorEditor({
  value,
  onChange,
  disabled = false,
  idPrefix = "error-behavior",
  schemaPath = "errorBehavior",
  onClearVariable,
}: ErrorBehaviorEditorProps) {
  const resolvedValue = useMemo(() => normalizeErrorBehavior(value), [value]);
  const [maxRetriesInput, setMaxRetriesInput] = useState(
    String(resolvedValue.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES)
  );
  const [retryDelayInput, setRetryDelayInput] = useState(
    String(resolvedValue.retryDelaySec ?? "")
  );

  useEffect(() => {
    setMaxRetriesInput(
      String(resolvedValue.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES)
    );
  }, [resolvedValue.maxRetries]);

  useEffect(() => {
    setRetryDelayInput(String(resolvedValue.retryDelaySec ?? ""));
  }, [resolvedValue.retryDelaySec]);

  // A placeholder action may resolve to a retry, so its budget stays editable.
  const isRetry =
    isWorkflowVariablePlaceholder(resolvedValue.onError) ||
    isErrorBehaviorRetry(resolvedValue.onError);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${idPrefix}-on-error`}
          className="text-xs font-semibold uppercase text-description-fg"
          title={schemaTitle(
            `${schemaPath}.onError`,
            undefined,
            "What ctrlyoke should do when a step phase encounters an internal error, including pre-conditions, prompts/harnesses, end-conditions, and script steps. Retry Step re-runs the whole step; Retry Failed Phase re-runs only the phase that errored."
          )}
        >
          On Error
        </label>
        <WorkflowVariableValue
          value={resolvedValue.onError}
          label="On Error"
          onClear={onClearVariable ?? (() => onChange(DEFAULT_ERROR_BEHAVIOR))}
          disabled={disabled}
        >
          <CustomSelect
            id={`${idPrefix}-on-error`}
            value={resolvedValue.onError}
            onChange={(nextValue) =>
              onChange(
                applyActionDefaults(
                  resolvedValue,
                  nextValue as ErrorBehavior["onError"]
                )
              )
            }
            options={toSelectOptions(
              ERROR_BEHAVIOR_ACTION_OPTIONS_META,
              `${schemaPath}.onError`
            )}
            disabled={disabled}
            schemaPath={`${schemaPath}.onError`}
          />
        </WorkflowVariableValue>
      </div>

      {isRetry && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label
              htmlFor={`${idPrefix}-max-retries`}
              title={schemaTitle(`${schemaPath}.maxRetries`)}
              className="text-xs font-semibold uppercase text-description-fg"
            >
              Max Retries
            </label>
            <input
              id={`${idPrefix}-max-retries`}
              aria-label={schemaAriaLabel(
                "Max Retries",
                `${schemaPath}.maxRetries`
              )}
              title={schemaTitle(`${schemaPath}.maxRetries`)}
              type="text"
              inputMode="numeric"
              value={maxRetriesInput}
              onChange={(event) => setMaxRetriesInput(event.target.value)}
              onBlur={() => {
                const nextValue = parseNumberOrVariable(
                  maxRetriesInput,
                  (raw) => {
                    const parsed = parseInt(raw, 10);
                    return Number.isNaN(parsed)
                      ? DEFAULT_ERROR_BEHAVIOR_RETRIES
                      : Math.max(DEFAULT_ERROR_BEHAVIOR_RETRIES, parsed);
                  }
                );
                setMaxRetriesInput(String(nextValue));
                onChange({
                  ...resolvedValue,
                  maxRetries: asAuthoredValue<number>(nextValue),
                });
              }}
              disabled={disabled}
              className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded-sm focus:outline-hidden focus:border-focus-border"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor={`${idPrefix}-retry-delay`}
              title={schemaTitle(`${schemaPath}.retryDelaySec`)}
              className="text-xs font-semibold uppercase text-description-fg"
            >
              Retry Delay (s)
            </label>
            <input
              id={`${idPrefix}-retry-delay`}
              aria-label={schemaAriaLabel(
                "Retry Delay (s)",
                `${schemaPath}.retryDelaySec`
              )}
              title={schemaTitle(`${schemaPath}.retryDelaySec`)}
              type="text"
              inputMode="decimal"
              value={retryDelayInput}
              onChange={(event) => setRetryDelayInput(event.target.value)}
              onBlur={() => {
                const nextValue = parseNumberOrVariable(
                  retryDelayInput,
                  (raw) => {
                    const parsed = parseFloat(raw);
                    return Number.isFinite(parsed) && parsed > 0
                      ? parsed
                      : undefined;
                  }
                );
                setRetryDelayInput(
                  nextValue === undefined ? "" : String(nextValue)
                );
                const withoutRetryDelay = { ...resolvedValue };
                delete withoutRetryDelay.retryDelaySec;
                onChange({
                  ...withoutRetryDelay,
                  maxRetries:
                    resolvedValue.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES,
                  ...(nextValue !== undefined && {
                    retryDelaySec: asAuthoredValue<number>(nextValue),
                  }),
                });
              }}
              disabled={disabled}
              className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded-sm focus:outline-hidden focus:border-focus-border"
            />
          </div>
        </div>
      )}
    </div>
  );
}
