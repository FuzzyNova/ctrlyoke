import { useEffect } from "react";
import { createPortal } from "react-dom";

export type StepContextMenuItem = {
  label: string;
  icon: string;
  disabled: boolean;
  disabledTitle?: string;
  onClick: () => void;
};

export type StepContextMenuState = {
  x: number;
  y: number;
  items: StepContextMenuItem[];
};

type StepContextMenuProps = StepContextMenuState & { onClose: () => void };

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
 */
export function StepContextMenu({
  x,
  y,
  items,
  onClose,
}: StepContextMenuProps) {
  const menuWidth = 170;
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 4);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
      style={{ position: "fixed", top: y, left: adjustedX, zIndex: 9999 }}
      className="bg-editor-bg border border-panel-border rounded shadow-lg py-0.5 min-w-[160px]"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className={`flex items-center gap-1.5 w-full px-2.5 py-1 text-[11px] text-left transition-colors ${
            item.disabled
              ? "text-description-fg cursor-not-allowed opacity-50"
              : "text-foreground hover:bg-toolbar-hover-bg cursor-pointer"
          }`}
          disabled={item.disabled}
          title={item.disabled ? item.disabledTitle : undefined}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onClick();
          }}
        >
          <i className={`codicon ${item.icon} text-[10px]`} />
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
