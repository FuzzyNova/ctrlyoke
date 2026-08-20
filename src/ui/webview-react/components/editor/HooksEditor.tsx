import React, { useCallback, useMemo } from "react";
import { HOOK_EVENT_METADATA } from "@root/types/DashboardConstants";
import type { UserHookConfig } from "@root/types/CtrlYokeTypes";
import type { CompatibilityDiagnostic } from "@root/types/CompatibilityTypes";
import { toFieldDiagnostic } from "@utils/compatibilityDiagnostics";
import { FieldDiagnostic } from "../shared/FieldDiagnostic";
import { KeyValueMapEditor } from "../shared/KeyValueMapEditor";

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
}

type EditorMode = "default" | "none" | "custom";

function getMode(value: HooksValue): EditorMode {
  if (value === undefined) return "default";
  if (value === null || (Array.isArray(value) && value.length === 0))
    return "none";
  return "custom";
}

export const HooksEditor: React.FC<HooksEditorProps> = ({
  value,
  onChange,
  inheritedValue = [],
  showDefault = true,
  diagnostics = [],
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
      if (newMode === "default") onChange(undefined);
      else if (newMode === "none") onChange(null);
      else onChange([{ event: "stop", command: "" }]);
    },
    [onChange]
  );

  const handleAddHook = useCallback(() => {
    onChange([...hooks, { event: "stop", command: "" }]);
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
      {(["default", "none", "custom"] as const).map((m) => (
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
          {m === "default" ? "Inherit" : m === "none" ? "None" : "Custom"}
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
  if (mode === "default" && showDefault) {
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
  if (mode === "none" && showDefault) {
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
          <div key={index} className="flex gap-1 items-start">
            <select
              id={`hook-${index}-event`}
              value={hook.event}
              onChange={(e) =>
                handleUpdateHook(index, {
                  event: e.target.value as UserHookConfig["event"],
                })
              }
              className="bg-input-bg text-input-fg border border-input-border rounded px-1 py-0.5 text-xs min-w-[120px]"
            >
              {HOOK_EVENT_METADATA.map((m) => (
                <option key={m.event} value={m.event}>
                  {m.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              id={`hook-${index}-command`}
              value={hook.command}
              onChange={(e) =>
                handleUpdateHook(index, { command: e.target.value })
              }
              placeholder="node ./scripts/my-hook.js"
              className="flex-1 bg-input-bg text-input-fg border border-input-border rounded px-2 py-0.5 text-xs font-mono"
            />
            <div className="flex min-w-[180px] flex-col gap-1">
              <label
                htmlFor={`hook-${index}-timeout-sec`}
                className="text-xxs text-description-fg"
              >
                Timeout (seconds)
              </label>
              <input
                type="number"
                id={`hook-${index}-timeout-sec`}
                value={hook.timeoutSec ?? ""}
                min={0}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const timeoutSec = raw === "" ? undefined : Number(raw);
                  handleUpdateHook(
                    index,
                    raw === ""
                      ? { timeoutSec: undefined }
                      : Number.isFinite(timeoutSec)
                        ? { timeoutSec }
                        : {}
                  );
                }}
                placeholder="Default"
                className="bg-input-bg text-input-fg border border-input-border rounded px-2 py-0.5 text-xs"
              />
            </div>
            <KeyValueMapEditor
              id={`hook-${index}-env`}
              label="Environment"
              ariaLabel={`hook-${index}-env`}
              value={hook.env ?? {}}
              onChange={(env) =>
                handleUpdateHook(index, {
                  env: Object.keys(env).length > 0 ? env : undefined,
                })
              }
              allowSecretReferences
              rows={2}
            />
            <button
              type="button"
              onClick={() => handleRemoveHook(index)}
              className="text-description-fg hover:text-error-fg text-xs px-1 cursor-pointer"
              title="Remove hook"
            >
              ✕
            </button>
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
