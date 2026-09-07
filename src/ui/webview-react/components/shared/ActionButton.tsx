import { USER_FEEDBACK_SEVERITY } from "@root/types/DashboardConstants";
import { Icon } from "./Icon";

export interface ActionFeedback {
  status:
    | typeof USER_FEEDBACK_SEVERITY.SUCCESS
    | typeof USER_FEEDBACK_SEVERITY.ERROR;
  message: string;
}

interface ActionButtonProps {
  label: string;
  pendingLabel?: string;
  /** Label shown during an inline success flash (see `success`). Defaults to `label`. */
  successLabel?: string;
  /** Codicon name (without the `codicon-` prefix) shown before the label while idle. */
  icon?: string;
  /** Codicon name shown during an inline success flash. Defaults to "check". */
  successIcon?: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  /**
   * Inline success flash: recolors the button itself and swaps in
   * `successIcon`/`successLabel` instead of showing a separate feedback line.
   * Mutually exclusive in practice with `feedback` — pick one display style
   * per call site.
   */
  success?: boolean;
  /** Below-button success/error line, cleared by the caller after a delay. */
  feedback?: ActionFeedback;
  title?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Single source for action buttons that report pending/success state:
 * a spinner while pending, then either an inline success flash (icon/label
 * swap, no click) or a feedback line below the button, depending on which
 * props the caller supplies.
 */
export function ActionButton({
  label,
  pendingLabel,
  successLabel,
  icon,
  successIcon = "check",
  onClick,
  disabled,
  pending = false,
  success = false,
  feedback,
  title,
  ariaLabel,
  className: customClassName = "",
}: ActionButtonProps) {
  const flashing = success && !pending;
  const displayLabel = pending
    ? (pendingLabel ?? label)
    : flashing
      ? (successLabel ?? label)
      : label;
  const iconName = pending ? "loading" : flashing ? successIcon : icon;

  const className = `fp-select-trigger text-xs inline-flex items-center gap-1 w-auto transition-colors ${
    flashing
      ? "text-indicator-success border-indicator-success cursor-default"
      : "hover:bg-list-hover-bg hover:text-foreground disabled:hover:bg-dropdown-bg disabled:hover:text-dropdown-fg"
  }`;

  const content = (
    <>
      {iconName && (
        <Icon
          name={iconName}
          className={`text-xxs ${pending ? "codicon-modifier-spin" : ""}`}
        />
      )}
      {displayLabel}
    </>
  );

  return (
    <div className="flex flex-col items-start gap-0.5">
      <button
        type="button"
        className={`${className} ${customClassName}`}
        disabled={disabled || pending || flashing}
        onClick={flashing ? undefined : onClick}
        title={title}
        aria-label={ariaLabel}
      >
        {content}
      </button>
      {feedback && (
        <span
          className={`text-xxs ${feedback.status === USER_FEEDBACK_SEVERITY.SUCCESS ? "text-indicator-success" : "text-error-fg"}`}
          role="status"
        >
          {feedback.message}
        </span>
      )}
    </div>
  );
}
