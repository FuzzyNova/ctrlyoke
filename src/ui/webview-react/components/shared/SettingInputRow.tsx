import type { ReactNode } from "react";
import type { SettingSource } from "@root/types/WebviewMessageTypes";
import { SettingSourceBadge } from "./SettingSourceBadge";

interface Props {
  label: string;
  description?: string;
  id?: string;
  path?: string;
  sources?: Record<string, SettingSource>;
  onReset?: (path: string) => void;
  activeScope?: "workspace" | "user";
  children: ReactNode;
}

export function SettingInputRow({
  label,
  description,
  id,
  path,
  sources,
  onReset,
  activeScope,
  children,
}: Props) {
  const source = path && sources ? sources[path] : undefined;
  const canReset =
    source !== undefined && source !== "default" && source === activeScope;

  return (
    <div className="group">
      <div className="flex items-center gap-1.5 mb-1">
        <label htmlFor={id} className="text-xs text-description-fg">
          {label}
        </label>
        {source && source !== "default" && (
          <SettingSourceBadge source={source} />
        )}
        {onReset && path && (
          <button
            type="button"
            aria-label={`Reset ${label}`}
            onClick={() => {
              if (canReset) onReset(path);
            }}
            disabled={!canReset}
            title={
              canReset
                ? "Reset to default"
                : source
                  ? `Defined in ${source} config`
                  : undefined
            }
            className={`w-4 h-4 flex items-center justify-center rounded text-description-fg hover:text-foreground transition-opacity ${
              canReset
                ? "opacity-0 group-hover:opacity-100"
                : "opacity-0 pointer-events-none"
            }`}
          >
            <i className="codicon codicon-discard text-xxs" />
          </button>
        )}
      </div>
      {children}
      {description && (
        <p className="text-xs text-description-fg mt-1">{description}</p>
      )}
    </div>
  );
}
