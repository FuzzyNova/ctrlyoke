import React from "react";

interface ExitButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {}

/**
 * Standard icon-only control for dismissing a panel, drawer, or popup.
 */
export const ExitButton: React.FC<ExitButtonProps> = ({
  className = "",
  type = "button",
  ...props
}) => (
  <button
    type={type}
    className={`control-button flex h-6 w-6 appearance-none items-center justify-center rounded border border-btn-border bg-btn-secondary-bg p-0 leading-none text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover ${className}`}
    {...props}
  >
    <span
      className="codicon codicon-close block leading-none"
      aria-hidden="true"
    />
  </button>
);
