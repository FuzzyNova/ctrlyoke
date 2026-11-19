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

export type ContextMenuItem = {
  label: string;
  icon: string;
  disabled: boolean;
  title?: string;
  disabledTitle?: string;
  onClick: () => void;
};

export type ContextMenuDivider = {
  type: "divider";
};

/**
 * An item that opens a nested list in place of the menu's own items, with a
 * Back row above it. Drilling in rather than flying out to the side works the
 * same with a mouse, a keyboard and a tap on a narrow phone screen.
 */
export type ContextMenuSubmenu = Omit<ContextMenuItem, "onClick"> & {
  submenu: ContextMenuEntry[];
};

export type ContextMenuEntry =
  ContextMenuItem | ContextMenuSubmenu | ContextMenuDivider;

export type ContextMenuState = {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  /** Accessible name of the menu; defaults to {@link DEFAULT_MENU_LABEL}. */
  label?: string;
  /**
   * Leave focus where it is instead of moving it into the menu, and keep taps
   * on the menu from taking it. Set when a long press opens the menu over a
   * text editor: on a phone, moving focus out of the editor dismisses the
   * on-screen keyboard, which reflows the layout out from under the menu.
   */
  keepInvokerFocus?: boolean;
};

type ContextMenuProps = ContextMenuState & { onClose: () => void };

const DEFAULT_MENU_LABEL = "Context menu";

function isDividerEntry(item: ContextMenuEntry): item is ContextMenuDivider {
  return "type" in item && item.type === "divider";
}

export function isSubmenuEntry(
  item: ContextMenuEntry
): item is ContextMenuSubmenu {
  return "submenu" in item;
}

const MENU_ITEM_CLASS =
  "cy-dropdown-row flex items-center gap-1.5 w-full px-2.5 py-1 text-xs text-left transition-colors focus-visible:bg-toolbar-hover-bg";
const MENU_ITEM_ENABLED_CLASS =
  "text-foreground hover:bg-toolbar-hover-bg cursor-pointer";
const MENU_ITEM_DISABLED_CLASS =
  "text-description-fg cursor-not-allowed opacity-50";

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
 * With `keepInvokerFocus` the menu takes no focus at all (see that prop), and
 * a resize of the window or visual viewport closes it: if the on-screen
 * keyboard closes anyway, the menu's fixed position no longer points at the
 * editor it was opened on. Menus that take focus can't close on resize, since
 * taking focus is itself what dismisses the keyboard.
 */
export function ContextMenu({
  x,
  y,
  items,
  label = DEFAULT_MENU_LABEL,
  keepInvokerFocus = false,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [invoker] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );
  // The submenus drilled into, outermost first; empty shows `items`.
  const [openSubmenus, setOpenSubmenus] = useState<ContextMenuSubmenu[]>([]);
  const openSubmenu = openSubmenus[openSubmenus.length - 1] as
    ContextMenuSubmenu | undefined;
  const visibleItems = openSubmenu?.submenu ?? items;

  // Re-measured on every drill in or out: a submenu is usually a different
  // size, and the menu must stay inside the viewport either way.
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const { width, height } = menuRef.current.getBoundingClientRect();
    const clampedX = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    const clampedY = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    setPos({ x: clampedX, y: clampedY });
  }, [x, y, openSubmenus]);

  // A `visibility: hidden` element cannot take focus, so wait for the
  // measured position before focusing the first item.
  const isVisible = pos !== null;
  useEffect(() => {
    if (!isVisible || !menuRef.current || keepInvokerFocus) return;
    enabledMenuItems(menuRef.current)[0]?.focus({ preventScroll: true });
  }, [isVisible, keepInvokerFocus, openSubmenus]);

  const enterSubmenu = (submenu: ContextMenuSubmenu) =>
    setOpenSubmenus((open) => [...open, submenu]);
  const leaveSubmenu = () => setOpenSubmenus((open) => open.slice(0, -1));

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
    const resizeTargets: EventTarget[] = keepInvokerFocus
      ? [window, ...(window.visualViewport ? [window.visualViewport] : [])]
      : [];
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    resizeTargets.forEach((t) => t.addEventListener("resize", close));
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
      resizeTargets.forEach((t) => t.removeEventListener("resize", close));
    };
  }, [onClose, keepInvokerFocus]);

  const handleMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === KEYBOARD_KEYS.ESCAPE || e.key === KEYBOARD_KEYS.TAB) {
      e.preventDefault();
      e.stopPropagation();
      restoreFocusAndClose();
      return;
    }
    if (e.key === KEYBOARD_KEYS.ARROW_LEFT && openSubmenu) {
      e.preventDefault();
      leaveSubmenu();
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
      // cy-no-select: the menu is portaled to body, outside any chrome that
      // carries the class, and the long press that opened it otherwise lands
      // in an iOS text selection of the item labels.
      className="context-menu cy-no-select bg-editor-bg border border-panel-border rounded-sm shadow-lg py-0.5 min-w-[160px] max-w-[min(24rem,calc(100vw-8px))] max-h-[calc(100vh-8px)] overflow-y-auto outline-none"
      onKeyDown={handleMenuKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      // Focus moves on mousedown (a tap's emulated one, too); cancelling it
      // keeps the editor focused, and the click still fires.
      onMouseDown={keepInvokerFocus ? (e) => e.preventDefault() : undefined}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {openSubmenu && (
        <>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-label={`Back from ${openSubmenu.label}`}
            className={`${MENU_ITEM_CLASS} ${MENU_ITEM_ENABLED_CLASS} font-semibold`}
            onClick={leaveSubmenu}
          >
            <Icon name="codicon-chevron-left" className="text-xxs" />
            {openSubmenu.label}
          </button>
          <div role="separator" className="h-px my-0.5 mx-1 bg-panel-border" />
        </>
      )}
      {visibleItems.map((item, i) =>
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
            aria-haspopup={isSubmenuEntry(item) ? "menu" : undefined}
            className={`${MENU_ITEM_CLASS} ${
              item.disabled ? MENU_ITEM_DISABLED_CLASS : MENU_ITEM_ENABLED_CLASS
            }`}
            disabled={item.disabled}
            title={item.disabled ? item.disabledTitle : item.title}
            onKeyDown={
              isSubmenuEntry(item)
                ? (e) => {
                    if (e.key !== KEYBOARD_KEYS.ARROW_RIGHT) return;
                    e.preventDefault();
                    e.stopPropagation();
                    enterSubmenu(item);
                  }
                : undefined
            }
            onClick={() => {
              if (item.disabled) return;
              if (isSubmenuEntry(item)) {
                enterSubmenu(item);
                return;
              }
              restoreFocusAndClose();
              item.onClick();
            }}
          >
            <Icon name={item.icon} className="text-xxs" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {isSubmenuEntry(item) && (
              <Icon name="codicon-chevron-right" className="text-xxs" />
            )}
          </button>
        )
      )}
    </div>,
    document.body
  );
}
