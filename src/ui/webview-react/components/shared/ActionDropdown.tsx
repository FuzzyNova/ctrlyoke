import { useState, useRef } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { DropdownPortal } from "./DropdownPortal";

export interface ActionDropdownItem {
  label: string;
  value: string;
  disabled?: boolean;
  title?: string;
}

export interface ActionDropdownProps {
  label: string;
  items: ActionDropdownItem[];
  onSelect: (value: string) => void;
  className?: string;
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
  items,
  onSelect,
  className = "",
}: ActionDropdownProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const rawPos = useDropdownPortalPosition(buttonRef, open);
  const popupPos = rawPos
    ? {
        top: rawPos.top,
        bottom: rawPos.bottom,
        left: rawPos.left,
        minWidth: Math.max(rawPos.width ?? 0, 140),
        maxHeight: rawPos.maxHeight,
      }
    : null;
  useClickOutside([buttonRef, popupRef], open, () => setOpen(false));

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border hover:bg-btn-secondary-hover"
      >
        {label}
        <i className={`codicon codicon-chevron-${open ? "up" : "down"} text-[10px]`} />
      </button>

      <DropdownPortal isOpen={open} popupPos={popupPos} ref={popupRef}>
            {items.map((item) => (
              <button
                key={item.value}
                type="button"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(false);
                  onSelect(item.value);
                }}
                className={`block w-full text-left px-3 py-1.5 text-xs transition-colors
                  ${
                    item.disabled
                      ? "text-disabled-fg cursor-default"
                      : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg cursor-pointer"
                  }`}
              >
                {item.label}
              </button>
            ))}
          </DropdownPortal>
    </div>
  );
}
