import React from "react";
import { ExitButton } from "@components/shared";
import { Icon } from "../shared/Icon";

interface DropdownDrawerHeaderProps {
  /** Main title, truncated to one line. */
  title: string;
  /** Muted lead-in shown before the title (e.g. "Schedule"). */
  eyebrow?: string;
  /** Accessible name and tooltip of the back button. */
  backLabel: string;
  onBack: () => void;
  onClose?: () => void;
  /** Extra header actions rendered between the title and the close button. */
  children?: React.ReactNode;
}

/**
 * Pinned header of a view that slides over the workflow dropdown's list (the
 * run panel, the schedule panel): back, title, optional actions, close.
 */
export const DropdownDrawerHeader: React.FC<DropdownDrawerHeaderProps> = ({
  title,
  eyebrow,
  backLabel,
  onBack,
  onClose,
  children,
}) => (
  <div className="dropdown-drawer-header flex shrink-0 items-center gap-1 border-b border-dropdown-border bg-editor-bg px-2 py-2">
    <button
      type="button"
      onClick={onBack}
      title={backLabel}
      aria-label={backLabel}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-description-fg hover:bg-list-hover-bg hover:text-foreground"
    >
      <Icon name="chevron-left" className="text-sm" />
    </button>
    <span
      className="min-w-0 flex-1 truncate text-sm text-foreground"
      title={eyebrow ? `${eyebrow} ${title}` : title}
    >
      {eyebrow && <span className="mr-1 text-description-fg">{eyebrow}</span>}
      <span className="font-semibold">{title}</span>
    </span>
    {children}
    {onClose && (
      <ExitButton
        onClick={onClose}
        title="Close workflow menu"
        aria-label="Close workflow menu"
      />
    )}
  </div>
);
