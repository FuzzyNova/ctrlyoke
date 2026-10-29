import React from "react";
import { Icon } from "./Icon";

interface ExitButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> {
  "aria-label": string;
}

/**
 * Classes of the exit button, and of its codicon, for DOM built outside React
 * (CodeMirror's search panel) that must match it.
 */
export const EXIT_BUTTON_CLASS =
  "control-button flex h-6 w-6 appearance-none items-center justify-center rounded-sm border border-btn-border bg-btn-secondary-bg p-0 leading-none text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover";
export const EXIT_BUTTON_ICON_CLASS = "block leading-none";

/**
 * Standard icon-only control for dismissing a panel, drawer, or popup.
 */
export const ExitButton: React.FC<ExitButtonProps> = ({
  className = "",
  type = "button",
  "aria-label": ariaLabel,
  ...props
}) => (
  <button
    type={type}
    className={`${EXIT_BUTTON_CLASS} ${className}`}
    aria-label={ariaLabel}
    {...props}
  >
    <Icon name="close" className={EXIT_BUTTON_ICON_CLASS} />
  </button>
);
