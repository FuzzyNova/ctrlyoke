import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

export type StepContextMenuItem = {
  label: string;
  icon: string;
  disabled: boolean;
  title?: string;
  disabledTitle?: string;
  onClick: () => void;
};

export type StepContextMenuDivider = {
  type: "divider";
};

export type StepContextMenuEntry = StepContextMenuItem | StepContextMenuDivider;

export type StepContextMenuState = {
  x: number;
  y: number;
  items: StepContextMenuEntry[];
};

type StepContextMenuProps = StepContextMenuState & { onClose: () => void };

function isDividerEntry(
  item: StepContextMenuEntry
): item is StepContextMenuDivider {
  return "type" in item && item.type === "divider";
}

/**
 * Fixed-position context menu rendered into document.body via portal.
 *
 * Close behaviour: a `pointerdown` listener on `document` closes the menu when
 * the user clicks or right-clicks anywhere outside it. `pointerdown` fires
 * before `contextmenu`, so right-clicking another item will close this menu
 * first, then the item's own `onContextMenu` handler opens a new one.
 *
 * Clicks *inside* the menu stop `pointerdown` propagation so the document
 * listener doesn't fire and menu-item `click` events still reach their handler.
 *
 * Positioning: the menu is rendered hidden on the first paint so its actual
 * dimensions can be measured, then clamped within the viewport before becoming
 * visible — preventing overflow at the bottom or right edges.
 */
export function StepContextMenu({
  x,
  y,
  items,
  onClose,
}: StepContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const { width, height } = menuRef.current.getBoundingClientRect();
    const clampedX = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    const clampedY = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    setPos({ x: clampedX, y: clampedY });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === KEYBOARD_KEYS.ESCAPE) onClose();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: pos?.y ?? y,
        left: pos?.x ?? x,
        zIndex: 9999,
        visibility: pos ? "visible" : "hidden",
      }}
      role="presentation"
      className="step-context-menu bg-editor-bg border border-panel-border rounded-sm shadow-lg py-0.5 min-w-[160px]"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item, i) =>
        isDividerEntry(item) ? (
          <div
            key={i}
            role="separator"
            className="h-px my-0.5 mx-1 bg-panel-border"
          />
        ) : (
          <button
            key={i}
            className={`flex items-center gap-1.5 w-full px-2.5 py-1 text-xs text-left transition-colors ${
              item.disabled
                ? "text-description-fg cursor-not-allowed opacity-50"
                : "text-foreground hover:bg-toolbar-hover-bg cursor-pointer"
            }`}
            disabled={item.disabled}
            title={item.disabled ? item.disabledTitle : item.title}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onClick();
            }}
          >
            <Icon name={item.icon} className="text-xxs" />
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  );
}
