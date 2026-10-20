import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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
  /** Accessible name of the menu; defaults to {@link DEFAULT_MENU_LABEL}. */
  label?: string;
};

type StepContextMenuProps = StepContextMenuState & { onClose: () => void };

const DEFAULT_MENU_LABEL = "Context menu";

function isDividerEntry(
  item: StepContextMenuEntry
): item is StepContextMenuDivider {
  return "type" in item && item.type === "divider";
}

function enabledMenuItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
  );
}

/** Index of the item a navigation key moves to, or null for other keys. */
function nextMenuItemIndex(
  key: string,
  current: number,
  count: number
): number | null {
  switch (key) {
    case KEYBOARD_KEYS.ARROW_DOWN:
      return current < 0 ? 0 : (current + 1) % count;
    case KEYBOARD_KEYS.ARROW_UP:
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case KEYBOARD_KEYS.HOME:
      return 0;
    case KEYBOARD_KEYS.END:
      return count - 1;
    default:
      return null;
  }
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
 *
 * Keyboard: follows the WAI-ARIA menu pattern. The first enabled item takes
 * focus once the menu is visible; ArrowUp/ArrowDown wrap through the enabled
 * items and Home/End jump to the ends. Escape, Tab and choosing an item return
 * focus to whatever held it when the menu opened, before the item's action
 * runs — editor actions such as Cut depend on the editor having focus again.
 */
export function StepContextMenu({
  x,
  y,
  items,
  label = DEFAULT_MENU_LABEL,
  onClose,
}: StepContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [invoker] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const { width, height } = menuRef.current.getBoundingClientRect();
    const clampedX = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    const clampedY = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    setPos({ x: clampedX, y: clampedY });
  }, [x, y]);

  // A `visibility: hidden` element cannot take focus, so wait for the
  // measured position before focusing the first item.
  const isVisible = pos !== null;
  useEffect(() => {
    if (!isVisible || !menuRef.current) return;
    enabledMenuItems(menuRef.current)[0]?.focus({ preventScroll: true });
  }, [isVisible]);

  const restoreFocusAndClose = useCallback(() => {
    if (invoker?.isConnected && invoker !== document.body) {
      invoker.focus({ preventScroll: true });
    }
    onClose();
  }, [invoker, onClose]);

  // Escape still closes when focus never reached the menu (every item
  // disabled); keys pressed inside it are handled by `handleMenuKeyDown`.
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

  const handleMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === KEYBOARD_KEYS.ESCAPE || e.key === KEYBOARD_KEYS.TAB) {
      e.preventDefault();
      e.stopPropagation();
      restoreFocusAndClose();
      return;
    }
    const menuItems = enabledMenuItems(e.currentTarget);
    if (menuItems.length === 0) return;
    const next = nextMenuItemIndex(
      e.key,
      menuItems.indexOf(document.activeElement as HTMLButtonElement),
      menuItems.length
    );
    if (next === null) return;
    e.preventDefault();
    menuItems[next].focus({ preventScroll: true });
  };

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
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className="step-context-menu bg-editor-bg border border-panel-border rounded-sm shadow-lg py-0.5 min-w-[160px] outline-none"
      onKeyDown={handleMenuKeyDown}
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
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`cy-dropdown-row flex items-center gap-1.5 w-full px-2.5 py-1 text-xs text-left transition-colors focus-visible:bg-toolbar-hover-bg ${
              item.disabled
                ? "text-description-fg cursor-not-allowed opacity-50"
                : "text-foreground hover:bg-toolbar-hover-bg cursor-pointer"
            }`}
            disabled={item.disabled}
            title={item.disabled ? item.disabledTitle : item.title}
            onClick={() => {
              if (item.disabled) return;
              restoreFocusAndClose();
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
