import React from "react";
import { useElementTier } from "@hooks/useElementNarrow";
import { Icon } from "./Icon";

export const STATUS_BANNER_TONES = {
  ERROR: "error",
  WARNING: "warning",
  INFO: "info",
} as const;

export type StatusBannerTone =
  (typeof STATUS_BANNER_TONES)[keyof typeof STATUS_BANNER_TONES];

/**
 * Each tone feeds its theme status color into `--cy-status-banner-bg`. The
 * `cy-status-banner` class (globals.css) paints that fill and derives flat
 * black or white text from its resolved luminance, whichever contrasts more.
 */
const TONE_BACKGROUND_CLASS: Record<StatusBannerTone, string> = {
  [STATUS_BANNER_TONES.ERROR]: "[--cy-status-banner-bg:var(--status-error)]",
  [STATUS_BANNER_TONES.WARNING]:
    "[--cy-status-banner-bg:var(--status-warning)]",
  [STATUS_BANNER_TONES.INFO]: "[--cy-status-banner-bg:var(--status-info)]",
};

/** Below this banner width, `narrowChildren` / `action.narrowLabel` apply. */
const STATUS_BANNER_NARROW_THRESHOLD = 480;

/**
 * The banner fills its container's width, so its own width never depends on
 * which text it shows — no hysteresis needed. A zero width means the element
 * has not been laid out (or is in jsdom), so it keeps the full wording.
 */
function resolveStatusBannerNarrow(width: number): boolean {
  return width > 0 && width < STATUS_BANNER_NARROW_THRESHOLD;
}

/** Shared class for text buttons placed inside a banner message. */
export const STATUS_BANNER_LINK_CLASS =
  "underline opacity-90 hover:opacity-100 focus-visible:outline focus-visible:outline-1";

export interface StatusBannerAction {
  label: string;
  /** Shorter label shown while the banner is narrow. */
  narrowLabel?: string;
  onClick: () => void;
  /** Accessible name; defaults to `label` so it is stable across widths. */
  "aria-label"?: string;
  title?: string;
}

export interface StatusBannerProps {
  tone: StatusBannerTone;
  icon: string;
  "aria-label": string;
  children: React.ReactNode;
  /** Shorter message shown while the banner is narrow. */
  narrowChildren?: React.ReactNode;
  action?: StatusBannerAction;
  iconClassName?: string;
}

/**
 * One status row: icon, message, and an optional right-aligned action.
 *
 * The row never wraps as a whole. The icon stays on the message's first line,
 * the message wraps beside it, and the action keeps its own line height on the
 * right, so a narrow panel costs extra message lines rather than stacking the
 * icon, message, and action on separate rows.
 */
export const StatusBanner: React.FC<StatusBannerProps> = ({
  tone,
  icon,
  "aria-label": ariaLabel,
  children,
  narrowChildren,
  action,
  iconClassName,
}) => {
  const [bannerRef, isNarrow] = useElementTier<boolean>(
    resolveStatusBannerNarrow,
    false
  );
  const actionLabel =
    isNarrow && action?.narrowLabel ? action.narrowLabel : action?.label;

  return (
    <div
      ref={bannerRef}
      className={`cy-status-banner flex items-start gap-2 px-3 py-0.5 text-sm leading-5 ${TONE_BACKGROUND_CLASS[tone]} border-b border-btn-border`}
      role="status"
      aria-label={ariaLabel}
    >
      <span className="flex h-5 flex-shrink-0 items-center">
        <Icon name={icon} className={iconClassName} />
      </span>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {isNarrow && narrowChildren !== undefined ? narrowChildren : children}
      </span>
      {action && (
        <button
          type="button"
          className={`flex-shrink-0 whitespace-nowrap ${STATUS_BANNER_LINK_CLASS}`}
          onClick={action.onClick}
          aria-label={action["aria-label"] ?? action.label}
          title={action.title}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
};
