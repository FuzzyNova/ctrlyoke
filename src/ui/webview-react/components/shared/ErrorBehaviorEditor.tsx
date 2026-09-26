import { useEffect, useMemo, useState } from "react";
import { CustomSelect } from "./CustomSelect";
import type { ErrorBehavior } from "@root/types/CtrlYokeTypes";
import { CONDITION_ACTIONS } from "@root/types/DashboardConstants";
import { ERROR_BEHAVIOR_ACTION_OPTIONS_META, toSelectOptions } from "@root/types/SchemaUiMetadata";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";

const DEFAULT_ERROR_BEHAVIOR: ErrorBehavior = {
  onError: CONDITION_ACTIONS.STOP_WORKFLOW,
};

function normalizeErrorBehavior(value: ErrorBehavior | null | undefined) {
  return value ?? DEFAULT_ERROR_BEHAVIOR;
}

function applyActionDefaults(
  current: ErrorBehavior,
  onError: ErrorBehavior["onError"]
): ErrorBehavior {
  if (onError !== CONDITION_ACTIONS.RETRY) {
    return { onError };
  }

  return {
    onError,
    maxRetries: current.maxRetries ?? 1,
    retryDelayMs: current.retryDelayMs ?? 0,
  };
}

interface ErrorBehaviorEditorProps {
  value: ErrorBehavior | null | undefined;
  onChange: (value: ErrorBehavior) => void;
  disabled?: boolean;
  idPrefix?: string;
  schemaPath?: string;
}

export function ErrorBehaviorEditor({
  value,
  onChange,
  disabled = false,
  idPrefix = "error-behavior",
  schemaPath = "errorBehavior",
}: ErrorBehaviorEditorProps) {
  const resolvedValue = useMemo(() => normalizeErrorBehavior(value), [value]);
  const [maxRetriesInput, setMaxRetriesInput] = useState(
    String(resolvedValue.maxRetries ?? 1)
  );
  const [retryDelayInput, setRetryDelayInput] = useState(
    String(resolvedValue.retryDelayMs ?? 0)
  );

  useEffect(() => {
    setMaxRetriesInput(String(resolvedValue.maxRetries ?? 1));
  }, [resolvedValue.maxRetries]);

  useEffect(() => {
    setRetryDelayInput(String(resolvedValue.retryDelayMs ?? 0));
  }, [resolvedValue.retryDelayMs]);

  const isRetry = resolvedValue.onError === CONDITION_ACTIONS.RETRY;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${idPrefix}-on-error`}
          className="text-xs font-semibold uppercase text-description-fg"
          title={schemaTitle(`${schemaPath}.onError`, undefined, "What ctrlyoke should do when a step phase encounters an internal error, including pre-conditions, prompts/harnesses, end-conditions, and script steps.")}
        >
          On Error
        </label>
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
          options={toSelectOptions(ERROR_BEHAVIOR_ACTION_OPTIONS_META, `${schemaPath}.onError`)}
          disabled={disabled}
          schemaPath={`${schemaPath}.onError`}
        />
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
              aria-label={schemaAriaLabel("Max Retries", `${schemaPath}.maxRetries`)}
              title={schemaTitle(`${schemaPath}.maxRetries`)}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={maxRetriesInput}
              onChange={(event) => setMaxRetriesInput(event.target.value)}
              onBlur={() => {
                const parsed = parseInt(maxRetriesInput, 10);
                const nextValue = Number.isNaN(parsed)
                  ? 1
                  : Math.max(1, parsed);
                setMaxRetriesInput(String(nextValue));
                onChange({
                  ...resolvedValue,
                  onError: CONDITION_ACTIONS.RETRY,
                  maxRetries: nextValue,
                  retryDelayMs: resolvedValue.retryDelayMs ?? 0,
                });
              }}
              disabled={disabled}
              className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor={`${idPrefix}-retry-delay`}
              title={schemaTitle(`${schemaPath}.retryDelayMs`)}
              className="text-xs font-semibold uppercase text-description-fg"
            >
              Retry Delay (ms)
            </label>
            <input
              id={`${idPrefix}-retry-delay`}
              aria-label={schemaAriaLabel("Retry Delay (ms)", `${schemaPath}.retryDelayMs`)}
              title={schemaTitle(`${schemaPath}.retryDelayMs`)}
              type="number"
              min={0}
              step={100}
              inputMode="numeric"
              value={retryDelayInput}
              onChange={(event) => setRetryDelayInput(event.target.value)}
              onBlur={() => {
                const parsed = parseInt(retryDelayInput, 10);
                const nextValue = Number.isNaN(parsed)
                  ? 0
                  : Math.max(0, parsed);
                setRetryDelayInput(String(nextValue));
                onChange({
                  ...resolvedValue,
                  onError: CONDITION_ACTIONS.RETRY,
                  maxRetries: resolvedValue.maxRetries ?? 1,
                  retryDelayMs: nextValue,
                });
              }}
              disabled={disabled}
              className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
            />
          </div>
        </div>
      )}
    </div>
  );
}
