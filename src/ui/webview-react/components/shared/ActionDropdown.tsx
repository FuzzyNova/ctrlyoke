import { useState, useRef } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { constrainPopupToViewport } from "@utils/dropdownUtils";
import { DropdownPortal } from "./DropdownPortal";

export interface ActionDropdownItem {
  label: string;
  value: string;
  description?: string;
  disabled?: boolean;
  title?: string;
  /** If true, renders as a non-interactive section header (value is used as React key only) */
  header?: boolean;
}

export interface ActionDropdownProps {
  label: string;
  /** Optional codicon name (without the `codicon-` prefix) shown before the label */
  icon?: string;
  items: ActionDropdownItem[];
  onSelect: (value: string) => void;
  className?: string;
  /** Render as a compact icon-only trigger (icon + chevron, no label text) */
  iconOnly?: boolean;
  /** Tooltip/aria-label shown when iconOnly hides the visible label */
  title?: string;
}

export function ActionDropdownItemContent({
  item,
}: {
  item: ActionDropdownItem;
}) {
  if (!item.description) {
    return <>{item.label}</>;
  }

  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{item.label}</span>
      <span className="truncate text-xxs leading-tight text-current opacity-70">
        {item.description}
      </span>
    </span>
  );
}

/**
 * A small action-menu button that opens a dropdown list.
 *
 * The popup is rendered via a React portal at document.body with
 * position:fixed so it escapes any overflow:hidden ancestors (e.g. file-list
 * containers). Uses the shared fp-dropdown-popup class for elevation / shadow.
 */
export function ActionDropdown({
  label,
  icon,
  items,
  onSelect,
  className = "",
  iconOnly = false,
  title,
}: ActionDropdownProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const dropdownMinWidth = items.some((item) => item.description) ? 240 : 140;

  const rawPos = useDropdownPortalPosition(buttonRef, open);
  const popupPos = rawPos
    ? (() => {
        const constrained = constrainPopupToViewport({
          left: rawPos.left,
          width: rawPos.width,
          minWidth: Math.max(rawPos.width ?? 0, dropdownMinWidth),
          preferredWidth: dropdownMinWidth,
        });
        return {
          top: rawPos.top,
          bottom: rawPos.bottom,
          left: constrained.left,
          width: constrained.width,
          minWidth: constrained.minWidth,
          maxWidth: constrained.maxWidth,
          maxHeight: rawPos.maxHeight,
        };
      })()
    : null;
  useClickOutside([buttonRef, popupRef], open, () => setOpen(false));

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((p) => !p)}
        title={iconOnly ? (title ?? label) : undefined}
        aria-label={iconOnly ? label : undefined}
        className={
          iconOnly
            ? `flex h-6 items-center justify-center gap-0.5 rounded border border-panel-border px-1.5 text-xxs transition-colors hover:border-focus-border ${
                className || "text-description-fg hover:text-foreground"
              }`
            : "flex w-full items-center justify-between gap-1 px-2 py-0.5 text-xs rounded bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border hover:bg-btn-secondary-hover"
        }
      >
        <span className="flex min-w-0 items-center gap-1 truncate">
          {icon && <i className={`codicon codicon-${icon} text-xxs`} />}
          {!iconOnly && <span className="truncate">{label}</span>}
        </span>
        <i
          className={`codicon codicon-chevron-${open ? "up" : "down"} text-[10px]`}
        />
      </button>

      <DropdownPortal isOpen={open} popupPos={popupPos} ref={popupRef}>
        {items.map((item) =>
          item.header ? (
            <div
              key={item.value}
              className="px-3 pt-2 pb-0.5 text-xxs font-semibold uppercase tracking-wide text-description-fg select-none"
            >
              {item.label}
            </div>
          ) : (
            <button
              key={item.value}
              type="button"
              disabled={item.disabled}
              title={
                [item.title, item.description].filter(Boolean).join("\n") ||
                undefined
              }
              onClick={() => {
                setOpen(false);
                onSelect(item.value);
              }}
              className={`fp-dropdown-row block w-full text-left px-3 py-1.5 text-xs transition-colors
                    ${
                      item.disabled
                        ? "text-disabled-fg cursor-default"
                        : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg cursor-pointer"
                    }`}
            >
              <ActionDropdownItemContent item={item} />
            </button>
          )
        )}
      </DropdownPortal>
    </div>
  );
}
