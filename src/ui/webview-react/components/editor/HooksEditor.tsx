import React, { useCallback, useMemo } from "react";

const HOOK_EVENTS = [
  { value: "stop", label: "Stop (session end)" },
  { value: "sessionStart", label: "Session Start" },
  { value: "preToolUse", label: "Pre Tool Use" },
  { value: "postToolUse", label: "Post Tool Use" },
  { value: "userPromptSubmit", label: "User Prompt Submit" },
] as const;

interface HookEntry {
  event: string;
  command: string;
  timeoutSec?: number;
}

type HooksValue = object[] | null | undefined;

interface HooksEditorProps {
  value: HooksValue;
  onChange: (value: HooksValue) => void;
  /** Resolved hooks from the tier below (workflow or global) for Default mode preview */
  inheritedValue?: object[];
  /** When true, hides the Default/None/Custom mode selector (for WorkflowPropertiesPanel global level) */
  showDefault?: boolean;
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
}) => {
  const mode = getMode(value);
  const hooks = useMemo<HookEntry[]>(
    () => (Array.isArray(value) ? (value as HookEntry[]) : []),
    [value]
  );

  const inherited: HookEntry[] = Array.isArray(inheritedValue)
    ? (inheritedValue as HookEntry[])
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
    (
      index: number,
      field: keyof HookEntry,
      val: string | number | undefined
    ) => {
      const updated = hooks.map((h, i) =>
        i === index ? { ...h, [field]: val } : h
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
              value={hook.event}
              onChange={(e) => handleUpdateHook(index, "event", e.target.value)}
              className="bg-input-bg text-input-fg border border-input-border rounded px-1 py-0.5 text-xs min-w-[120px]"
            >
              {HOOK_EVENTS.map((ev) => (
                <option key={ev.value} value={ev.value}>
                  {ev.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={hook.command}
              onChange={(e) =>
                handleUpdateHook(index, "command", e.target.value)
              }
              placeholder="node ./scripts/my-hook.js"
              className="flex-1 bg-input-bg text-input-fg border border-input-border rounded px-2 py-0.5 text-xs font-mono"
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
    </div>
  );
};
