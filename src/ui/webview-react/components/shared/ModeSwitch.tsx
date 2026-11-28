import React from "react";
import { Icon } from "./Icon";

export interface ModeSwitchOption<T extends string> {
  value: T;
  label: string;
  title: string;
  /** Codicon name. */
  icon?: string;
  /** Accessible name; defaults to `label`. */
  ariaLabel?: string;
  /** DOM id for the option's button. */
  id?: string;
}

export interface ModeSwitchProps<T extends string> {
  options: readonly ModeSwitchOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  ariaLabel: string;
  disabled?: boolean;
  /** Icons only, for a narrow header. */
  compact?: boolean;
  className?: string;
}

/**
 * A row of pressed/unpressed buttons choosing one mode: the step editor's
 * Prompt / Script / Workflow switch and Workflow mode's File / Inline and
 * inline Prompt / Script switches.
 */
export function ModeSwitch<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  compact = false,
  className,
}: ModeSwitchProps<T>): React.ReactElement {
  return (
    <div
      className={`cy-mode-switch${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option, index) => {
        const isActive = option.value === value;
        return (
          <React.Fragment key={option.value}>
            {index > 0 && (
              <div className="cy-mode-switch-divider">
                <div className="w-px h-full bg-current opacity-40" />
              </div>
            )}
            <button
              type="button"
              id={option.id}
              disabled={disabled}
              className={`cy-mode-switch-btn ${isActive ? "cy-mode-switch-btn-active" : "cy-mode-switch-btn-inactive"}`}
              onClick={() => onChange(option.value)}
              title={option.title}
              aria-label={option.ariaLabel ?? option.label}
              aria-pressed={isActive}
            >
              {option.icon && (
                <Icon
                  name={option.icon}
                  className={`codicon-sm ${compact ? "px-1" : ""}`}
                />
              )}
              {(!compact || !option.icon) && <span>{option.label}</span>}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
