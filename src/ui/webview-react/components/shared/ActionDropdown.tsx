import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

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
  const [popupPos, setPopupPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    minWidth: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 4;
    if (spaceBelow >= 80) {
      setPopupPos({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
    } else {
      setPopupPos({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
        minWidth: rect.width,
      });
    }
  }, []);

  useEffect(() => {
    if (open) {
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
    } else {
      setPopupPos(null);
    }
  }, [open, updatePosition]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!buttonRef.current?.contains(target) && !popupRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

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

      {open &&
        popupPos &&
        createPortal(
          <div
            ref={popupRef}
            className="fp-dropdown-popup fixed z-[9999] bg-dropdown-bg border border-dropdown-border overflow-hidden"
            style={{
              top: popupPos.top,
              bottom: popupPos.bottom,
              left: popupPos.left,
              minWidth: Math.max(popupPos.minWidth, 140),
            }}
          >
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
          </div>,
          document.body
        )}
    </div>
  );
}
