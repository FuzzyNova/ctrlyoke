import React from "react";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md" | "lg";
  children: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = "primary",
  size = "md",
  children,
  className = "",
  disabled,
  ...props
}) => {
  const baseClasses =
    "inline-flex items-center justify-center font-medium rounded-sm transition-colors focus:outline-hidden disabled:opacity-50 disabled:cursor-not-allowed";

  const variantClasses = {
    primary:
      "bg-btn-bg text-btn-fg hover:bg-btn-hover border border-btn-border",
    secondary:
      "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover",
    danger: "bg-indicator-error text-btn-fg hover:opacity-90",
  };

  const sizeClasses = {
    sm: "px-2 py-1 text-xs",
    md: "px-4 py-2 text-sm",
    lg: "px-6 py-3 text-base",
  };

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
};

/**
 * Bordered secondary button that spans its container, for the one action at
 * the foot of a property list (Manage MCP Servers, Add Hook).
 */
export const FullWidthButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }
> = ({ children, className = "", type = "button", ...props }) => (
  <button
    type={type}
    className={`flex w-full items-center justify-center gap-1 rounded-sm border border-btn-border bg-btn-secondary-bg px-3 py-1 text-xs text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    {...props}
  >
    {children}
  </button>
);
