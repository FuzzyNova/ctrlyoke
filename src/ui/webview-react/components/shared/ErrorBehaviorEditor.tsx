import { useEffect, useMemo, useState } from "react";
import { CustomSelect } from "./CustomSelect";
import type { ErrorBehavior } from "@root/types/CtrlYokeTypes";
import {
  CONDITION_ACTIONS,
  DEFAULT_ERROR_BEHAVIOR_RETRIES,
} from "@root/types/DashboardConstants";
import {
  ERROR_BEHAVIOR_ACTION_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
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

  const isRetry = resolvedValue.onError === CONDITION_ACTIONS.RETRY;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${idPrefix}-on-error`}
          className="text-xs font-semibold uppercase text-description-fg"
          title={schemaTitle(
            `${schemaPath}.onError`,
            undefined,
            "What ctrlyoke should do when a step phase encounters an internal error, including pre-conditions, prompts/harnesses, end-conditions, and script steps."
          )}
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
          options={toSelectOptions(
            ERROR_BEHAVIOR_ACTION_OPTIONS_META,
            `${schemaPath}.onError`
          )}
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
              aria-label={schemaAriaLabel(
                "Max Retries",
                `${schemaPath}.maxRetries`
              )}
              title={schemaTitle(`${schemaPath}.maxRetries`)}
              type="number"
              min={DEFAULT_ERROR_BEHAVIOR_RETRIES}
              step={1}
              inputMode="numeric"
              value={maxRetriesInput}
              onChange={(event) => setMaxRetriesInput(event.target.value)}
              onBlur={() => {
                const parsed = parseInt(maxRetriesInput, 10);
                const nextValue = Number.isNaN(parsed)
                  ? DEFAULT_ERROR_BEHAVIOR_RETRIES
                  : Math.max(DEFAULT_ERROR_BEHAVIOR_RETRIES, parsed);
                setMaxRetriesInput(String(nextValue));
                onChange({
                  ...resolvedValue,
                  onError: CONDITION_ACTIONS.RETRY,
                  maxRetries: nextValue,
                });
              }}
              disabled={disabled}
              className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
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
              type="number"
              min={0.001}
              step="any"
              inputMode="decimal"
              value={retryDelayInput}
              onChange={(event) => setRetryDelayInput(event.target.value)}
              onBlur={() => {
                const parsed = parseFloat(retryDelayInput);
                const nextValue =
                  Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
                setRetryDelayInput(
                  nextValue === undefined ? "" : String(nextValue)
                );
                const withoutRetryDelay = { ...resolvedValue };
                delete withoutRetryDelay.retryDelaySec;
                onChange({
                  ...withoutRetryDelay,
                  onError: CONDITION_ACTIONS.RETRY,
                  maxRetries:
                    resolvedValue.maxRetries ?? DEFAULT_ERROR_BEHAVIOR_RETRIES,
                  ...(nextValue !== undefined && { retryDelaySec: nextValue }),
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
