import React, { useCallback, useMemo } from "react";
import {
  INHERIT_DEFAULT_OPTION,
  HOOK_EVENT_NAMES,
  NONE_OPTION,
} from "@root/types/DashboardConstants";
import {
  HOOK_EVENT_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";
import type { UserHookConfig } from "@root/types/CtrlYokeTypes";
import type { CompatibilityDiagnostic } from "@root/types/CompatibilityTypes";
import { toFieldDiagnostic } from "@utils/compatibilityDiagnostics";
import { FieldDiagnostic } from "../shared/FieldDiagnostic";
import { KeyValueRowsEditor } from "../shared/KeyValueRowsEditor";
import { ScriptCommandEditor } from "../shared/ScriptCommandEditor";
import { Button } from "../shared/Button";
import { Icon } from "../shared/Icon";

type HooksValue = UserHookConfig[] | null | undefined;

interface HooksEditorProps {
  value: HooksValue;
  onChange: (value: HooksValue) => void;
  /** Resolved hooks from the tier below (workflow or global) for Default mode preview */
  inheritedValue?: UserHookConfig[];
  /** When true, hides the Default/None/Custom mode selector (for WorkflowPropertiesPanel global level) */
  showDefault?: boolean;
  /** Compatibility findings for configured hook events. */
  diagnostics?: readonly CompatibilityDiagnostic[];
  /** File-relative path to this hooks array. */
  schemaPath?: string;
}

type EditorMode = typeof INHERIT_DEFAULT_OPTION | typeof NONE_OPTION | "custom";

function getMode(value: HooksValue): EditorMode {
  if (value === undefined) return INHERIT_DEFAULT_OPTION;
  if (value === null || (Array.isArray(value) && value.length === 0))
    return NONE_OPTION;
  return "custom";
}

export const HooksEditor: React.FC<HooksEditorProps> = ({
  value,
  onChange,
  inheritedValue = [],
  showDefault = true,
  diagnostics = [],
  schemaPath = "hooks",
}) => {
  const mode = getMode(value);
  const hooks = useMemo<UserHookConfig[]>(
    () => (Array.isArray(value) ? value : []),
    [value]
  );

  const inherited: UserHookConfig[] = Array.isArray(inheritedValue)
    ? inheritedValue
    : [];

  const handleModeChange = useCallback(
    (newMode: EditorMode) => {
      if (newMode === INHERIT_DEFAULT_OPTION) onChange(undefined);
      else if (newMode === NONE_OPTION) onChange(null);
      else onChange([{ event: HOOK_EVENT_NAMES.STOP, command: "" }]);
    },
    [onChange]
  );

  const handleAddHook = useCallback(() => {
    onChange([...hooks, { event: HOOK_EVENT_NAMES.STOP, command: "" }]);
  }, [hooks, onChange]);

  const handleRemoveHook = useCallback(
    (index: number) => {
      const updated = hooks.filter((_, i) => i !== index);
      onChange(updated.length > 0 ? updated : null);
    },
    [hooks, onChange]
  );

  const handleUpdateHook = useCallback(
    (index: number, patch: Partial<UserHookConfig>) => {
      const updated = hooks.map((h, i) =>
        i === index
          ? (() => {
              const next = { ...h, ...patch };
              // Keep explicit undefined on optional fields so a later
              // workflow/step merge clears the authored key. JSON omits it.
              return next;
            })()
          : h
      );
      onChange(updated);
    },
    [hooks, onChange]
  );

  // Mode selector (only at prompt level, not global settings)
  const modeSelector = showDefault ? (
    <div className="flex gap-1 mb-2">
      {([INHERIT_DEFAULT_OPTION, NONE_OPTION, "custom"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => handleModeChange(m)}
          className={`px-2 py-0.5 text-xs rounded cursor-pointer ${
            mode === m
              ? "bg-button-bg text-button-fg"
              : "bg-transparent text-description-fg hover:text-fg"
          }`}
        >
          {m === INHERIT_DEFAULT_OPTION
            ? "Inherit"
            : m === NONE_OPTION
              ? "None"
              : "Custom"}
        </button>
      ))}
    </div>
  ) : null;
  const fieldDiagnostics = diagnostics.map((diagnostic) =>
    toFieldDiagnostic(diagnostic)
  );
  const diagnosticsView = (
    <FieldDiagnostic
      id="hooks-compatibility-diagnostics"
      diagnostics={fieldDiagnostics}
      className="mt-2"
    />
  );

  // Default mode — show inherited preview
  if (mode === INHERIT_DEFAULT_OPTION && showDefault) {
    return (
      <div>
        {modeSelector}
        {inherited.length > 0 ? (
          <div className="opacity-60 space-y-1">
            {inherited.map((h, i) => (
              <div key={i} className="text-xs font-mono text-description-fg">
                <span className="text-xxs uppercase">{h.event}</span>{" "}
                <span>{h.command}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-description-fg italic">
            No hooks inherited
          </p>
        )}
        {diagnosticsView}
      </div>
    );
  }

  // None mode (only block when mode selector is visible so user can switch back)
  if (mode === NONE_OPTION && showDefault) {
    return (
      <div>
        {modeSelector}
        <p className="text-xs text-description-fg italic">
          No hooks — inherited hooks suppressed
        </p>
        {diagnosticsView}
      </div>
    );
  }

  // Custom mode — inline list editor
  return (
    <div>
      {modeSelector}
      <div className="space-y-2">
        {hooks.map((hook, index) => (
          <div key={index} className="grid min-w-0 gap-2">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
              <div className="flex min-w-0 flex-col gap-1">
                <label
                  htmlFor={`hook-${index}-event`}
                  className="text-xxs text-description-fg"
                  title={schemaTitle(`${schemaPath}[].event`)}
                >
                  Event
                </label>
                <select
                  id={`hook-${index}-event`}
                  aria-label={schemaAriaLabel("Event", `${schemaPath}[].event`)}
                  title={schemaTitle(`${schemaPath}[].event`)}
                  value={hook.event}
                  onChange={(e) =>
                    handleUpdateHook(index, {
                      event: e.target.value as UserHookConfig["event"],
                    })
                  }
                  className="h-7 w-full min-w-0 rounded border border-input-border bg-input-bg px-1 py-0.5 text-xs text-input-fg"
                >
                  {toSelectOptions(
                    HOOK_EVENT_OPTIONS_META,
                    `${schemaPath}[].event`
                  ).map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                      aria-label={schemaAriaLabel(
                        option.label,
                        `${schemaPath}[].event`,
                        option.value
                      )}
                      title={schemaTitle(`${schemaPath}[].event`, option.value)}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <label
                  htmlFor={`hook-${index}-timeout-sec`}
                  title={schemaTitle(`${schemaPath}[].timeoutSec`)}
                  className="text-xxs text-description-fg"
                >
                  Timeout (seconds)
                </label>
                <input
                  type="number"
                  id={`hook-${index}-timeout-sec`}
                  aria-label={schemaAriaLabel(
                    "Timeout (seconds)",
                    `${schemaPath}[].timeoutSec`
                  )}
                  title={schemaTitle(`${schemaPath}[].timeoutSec`)}
                  value={hook.timeoutSec ?? ""}
                  min={1}
                  step={1}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === "") {
                      handleUpdateHook(index, { timeoutSec: undefined });
                      return;
                    }
                    const timeoutSec = Number(raw);
                    if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1) {
                      return;
                    }
                    handleUpdateHook(index, { timeoutSec });
                  }}
                  placeholder="Default"
                  className="h-7 w-full min-w-0 rounded border border-input-border bg-input-bg px-2 py-0.5 text-xs text-input-fg"
                />
              </div>
              <Button
                type="button"
                onClick={() => handleRemoveHook(index)}
                variant="danger"
                size="sm"
                aria-label="Remove hook"
                title="Remove hook"
                className="h-7 shrink-0 self-end px-1.5"
              >
                <Icon name="trash" />
              </Button>
            </div>
            <ScriptCommandEditor
              id={`hook-${index}-command`}
              value={hook.command}
              onChange={(command) => handleUpdateHook(index, { command })}
              placeholder="node ./scripts/my-hook.js"
              aria-label={`hook-${index}-command`}
              className="w-full min-w-0 rounded border border-input-border bg-input-bg text-xs font-mono text-input-fg"
            />
            <KeyValueRowsEditor
              id={`hook-${index}-env`}
              label="Environment"
              ariaLabel={`hook-${index}-env`}
              schemaPath={`${schemaPath}[].env`}
              value={hook.env ?? {}}
              onChange={(env) =>
                handleUpdateHook(index, {
                  env: Object.keys(env).length > 0 ? env : undefined,
                })
              }
              keyKind="env"
              entryNoun="environment variable"
              allowSecretReferences
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={handleAddHook}
        className="text-xs text-link-fg hover:underline mt-2 cursor-pointer"
      >
        + Add Hook
      </button>
      {diagnosticsView}
    </div>
  );
};
