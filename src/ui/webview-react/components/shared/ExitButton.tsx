import React from "react";
import { Icon } from "./Icon";

interface ExitButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> {
  "aria-label": string;
}

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
    className={`control-button flex h-6 w-6 appearance-none items-center justify-center rounded-sm border border-btn-border bg-btn-secondary-bg p-0 leading-none text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover ${className}`}
    aria-label={ariaLabel}
    {...props}
  >
    <Icon name="close" className="block leading-none" />
  </button>
);
