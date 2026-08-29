import React from "react";

export interface ScopeToggleOption<T extends string> {
  value: T;
  label: string;
  /** Codicon class, e.g. "codicon-person" */
  icon: string;
  title?: string;
}

interface ScopeToggleProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly [ScopeToggleOption<T>, ScopeToggleOption<T>];
  ariaLabel: string;
  className?: string;
  /** Render icons only, dropping the visible label text (still exposed via title/aria-label). */
  iconOnly?: boolean;
}

/**
 * Two-option segmented control (e.g. User/Workspace) built on the shared
 * `fp-mode-switch` CSS classes (globals.css) — single-sourced so every scope
 * picker in the app looks and behaves identically.
 */
export function ScopeToggle<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  iconOnly = false,
}: ScopeToggleProps<T>): React.ReactElement {
  const [first, second] = options;

  return (
    <div
      className={`fp-mode-switch${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        onClick={() => onChange(first.value)}
        className={`fp-mode-switch-btn ${value === first.value ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
        title={first.title ?? first.label}
        aria-label={first.label}
      >
        <i className={`codicon ${first.icon}`} />
        {!iconOnly && first.label}
      </button>
      <div className="fp-mode-switch-divider">
        <div className="w-px h-full bg-current opacity-40" />
      </div>
      <button
        type="button"
        onClick={() => onChange(second.value)}
        className={`fp-mode-switch-btn ${value === second.value ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
        title={second.title ?? second.label}
        aria-label={second.label}
      >
        <i className={`codicon ${second.icon}`} />
        {!iconOnly && second.label}
      </button>
    </div>
  );
}
