import React from "react";
import { Icon } from "./Icon";

export const STATUS_BANNER_TONES = {
  ERROR: "error",
  WARNING: "warning",
  INFO: "info",
} as const;

export type StatusBannerTone =
  (typeof STATUS_BANNER_TONES)[keyof typeof STATUS_BANNER_TONES];

/**
 * Text treatment for every tone. The backgrounds are theme-driven status
 * colors (`--status-error`/`--status-warning`/`--status-info`), which range
 * from pale to saturated depending on the active theme — no single themed
 * foreground token stays legible against all of them. White text with a black
 * outline reads clearly against any of these backgrounds regardless of theme.
 */
const BANNER_TEXT_CLASS =
  "font-bold text-white [text-shadow:_-1px_-1px_0_#000,_1px_-1px_0_#000,_-1px_1px_0_#000,_1px_1px_0_#000]";

const TONE_BACKGROUND_CLASS: Record<StatusBannerTone, string> = {
  [STATUS_BANNER_TONES.ERROR]: "bg-[var(--status-error)]",
  [STATUS_BANNER_TONES.WARNING]: "bg-[var(--status-warning)]",
  [STATUS_BANNER_TONES.INFO]: "bg-[var(--status-info)]",
};

export interface StatusBannerProps {
  tone: StatusBannerTone;
  icon: string;
  "aria-label": string;
  children: React.ReactNode;
  action?: React.ReactNode;
  iconClassName?: string;
  className?: string;
}

export const StatusBanner: React.FC<StatusBannerProps> = ({
  tone,
  icon,
  "aria-label": ariaLabel,
  children,
  action,
  iconClassName,
  className = "",
}) => (
  <div
    className={`flex items-center gap-2 px-3 py-1.5 text-xs ${TONE_BACKGROUND_CLASS[tone]} ${BANNER_TEXT_CLASS} border-b border-btn-border ${className}`}
    role="status"
    aria-label={ariaLabel}
  >
    <Icon name={icon} className={iconClassName} />
    <span>{children}</span>
    {action && <div className="ml-auto flex items-center gap-3">{action}</div>}
  </div>
);
