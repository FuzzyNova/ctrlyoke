import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { sendMessage } from "@hooks/useMessageHandler";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { constrainPopupToViewport } from "@utils/dropdownUtils";
import { DropdownPortal } from "../shared/DropdownPortal";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@/types/messages";
import type {
  TerminalMobileBarLayout,
  TerminalShortcut,
} from "@root/types/CtrlYokeSettings";
import {
  TERMINAL_BAR_CTRL_ID,
  TERMINAL_BAR_ITEM_REGISTRY,
  reconcileTerminalBarLayout,
  type TerminalBarRegistryId,
} from "@root/utils/TerminalControlBarFormat";
import { terminalRegistry } from "../../terminalRegistry";

interface TerminalControlBarProps {
  workflowId: string;
  sessionId: string;
}

// Shared empty fallback: a fresh `[]` inside a selector is a new snapshot on
// every read, which loops `useSyncExternalStore` (React #185) for as long as
// neither settings source carries the list.
const EMPTY_SHORTCUTS: TerminalShortcut[] = [];
const EMPTY_BAR_LAYOUT: TerminalMobileBarLayout = {
  bar: [],
  popup: [],
  hidden: [],
};

const MORE_POPUP_WIDTH = 192;

type ResolvedTerminalBarItem =
  | { kind: "ctrl"; id: typeof TERMINAL_BAR_CTRL_ID }
  | {
      kind: "shortcut";
      id: string;
      label: string;
      sequence: string;
      glyph?: string;
    };

function resolveTerminalBarItem(
  id: string,
  customShortcuts: readonly TerminalShortcut[]
): ResolvedTerminalBarItem | null {
  if (id === TERMINAL_BAR_CTRL_ID) {
    return { kind: "ctrl", id: TERMINAL_BAR_CTRL_ID };
  }

  const registryItem = TERMINAL_BAR_ITEM_REGISTRY[id as TerminalBarRegistryId];
  if (registryItem) {
    return {
      kind: "shortcut",
      id,
      label: registryItem.label,
      sequence: registryItem.sequence,
      glyph: "glyph" in registryItem ? registryItem.glyph : undefined,
    };
  }

  const customShortcut = customShortcuts.find((shortcut) => shortcut.id === id);
  if (!customShortcut || !customShortcut.label.trim()) {
    return null;
  }

  return {
    kind: "shortcut",
    id,
    label: customShortcut.label,
    sequence: decodeEscapeSequence(customShortcut.sequence),
  };
}

function decodeEscapeSequence(input: string): string {
  return input.replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|n|r|t|e|0|\\)/g,
    (_match, token: string) => {
      if (token.startsWith("x")) {
        return String.fromCharCode(Number.parseInt(token.slice(1), 16));
      }
      if (token.startsWith("u")) {
        return String.fromCharCode(Number.parseInt(token.slice(1), 16));
      }
      switch (token) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "e":
          return "\x1b";
        case "0":
          return "\x00";
        case "\\":
          return "\\";
        default:
          return token;
      }
    }
  );
}

function ctrlSequenceFromKey(key: string): string | null {
  if (key === " ") return "\x00";
  if (key.length !== 1) return null;
  const code = key.toUpperCase().charCodeAt(0);
  if (code < 64 || code > 95) return null;
  return String.fromCharCode(code - 64);
}

/**
 * Keeps focus in the terminal when a bar button or menu item is pressed.
 * Focus moves on mousedown (a tap's emulated one, too); on a phone, losing
 * it from xterm's textarea dismisses the on-screen keyboard, which reflows
 * the layout out from under the bar and its menu. Cancelling the mousedown
 * leaves focus where it was, and the click still fires.
 */
function keepTerminalFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

export const TerminalControlBar: React.FC<TerminalControlBarProps> = ({
  workflowId,
  sessionId,
}) => {
  const [ctrlActive, setCtrlActive] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const morePopupRef = useRef<HTMLDivElement>(null);
  const customShortcuts = useSettingsStore(
    (s) =>
      s.fullGlobalSettings?.settings.terminal.mobileCustomShortcuts ??
      s.globalSettings.terminal?.mobileCustomShortcuts ??
      EMPTY_SHORTCUTS
  );
  const mobileBarLayout = useSettingsStore(
    (s) =>
      s.fullGlobalSettings?.settings.terminal.mobileBarLayout ??
      s.globalSettings.terminal?.mobileBarLayout ??
      EMPTY_BAR_LAYOUT
  );
  const globalSettingsOpen = useUiStore((s) => s.globalSettingsOpen);
  const toggleGlobalSettings = useUiStore((s) => s.toggleGlobalSettings);
  const setGlobalSettingsTab = useUiStore((s) => s.setGlobalSettingsTab);

  const usableCustomShortcuts = useMemo(
    () =>
      customShortcuts.filter(
        (shortcut) => shortcut.label.trim() && shortcut.sequence.trim()
      ),
    [customShortcuts]
  );

  const reconciledBarLayout = useMemo(
    () =>
      reconcileTerminalBarLayout(
        mobileBarLayout,
        customShortcuts.map((shortcut) => shortcut.id)
      ),
    [customShortcuts, mobileBarLayout]
  );

  const resolvedBarItems = useMemo(
    () =>
      reconciledBarLayout.bar
        .map((id) => resolveTerminalBarItem(id, usableCustomShortcuts))
        .filter((item): item is ResolvedTerminalBarItem => item !== null),
    [reconciledBarLayout, usableCustomShortcuts]
  );

  const resolvedPopupItems = useMemo(
    () =>
      reconciledBarLayout.popup
        .map((id) => resolveTerminalBarItem(id, usableCustomShortcuts))
        .filter(
          (
            item
          ): item is Extract<ResolvedTerminalBarItem, { kind: "shortcut" }> =>
            item !== null && item.kind === "shortcut"
        ),
    [reconciledBarLayout, usableCustomShortcuts]
  );

  const focusTerminal = useCallback(() => {
    terminalRegistry.get(workflowId, sessionId)?.term.focus();
  }, [sessionId, workflowId]);

  const sendKey = useCallback(
    (sequence: string) => {
      sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, {
        workflowId,
        sessionId,
        data: sequence,
      });
      setCtrlActive(false);
      setMoreOpen(false);
      requestAnimationFrame(focusTerminal);
    },
    [focusTerminal, sessionId, workflowId]
  );

  useEffect(() => {
    if (!ctrlActive) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const sequence = ctrlSequenceFromKey(event.key);
      setCtrlActive(false);
      if (!sequence) return;
      event.preventDefault();
      event.stopPropagation();
      sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, {
        workflowId,
        sessionId,
        data: sequence,
      });
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [ctrlActive, sessionId, workflowId]);

  // The bar row scrolls horizontally, and `overflow-x: auto` forces
  // `overflow-y` to clip as well, so an absolutely positioned menu inside it
  // is cut off and never shows. Portal it out with fixed coordinates instead,
  // right-aligned to the "..." button (which sits at the row's right edge).
  const rawMorePos = useDropdownPortalPosition(moreButtonRef, moreOpen);
  const morePopupPos = useMemo(() => {
    if (!rawMorePos || !moreButtonRef.current) return null;
    const rect = moreButtonRef.current.getBoundingClientRect();
    const constrained = constrainPopupToViewport({
      left: rect.right - MORE_POPUP_WIDTH,
      width: MORE_POPUP_WIDTH,
    });
    return {
      ...rawMorePos,
      left: constrained.left,
      width: constrained.width,
      maxWidth: constrained.maxWidth,
    };
  }, [rawMorePos]);

  useClickOutside([moreButtonRef, morePopupRef], moreOpen, () =>
    setMoreOpen(false)
  );

  // If the on-screen keyboard opens or closes anyway, the layout moves and
  // the menu's fixed position no longer points at the bar: close it rather
  // than leave it dangling (same rule as StepContextMenu's keepInvokerFocus).
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!moreOpen || !viewport) return;
    const close = () => setMoreOpen(false);
    viewport.addEventListener("resize", close);
    return () => viewport.removeEventListener("resize", close);
  }, [moreOpen]);

  const openShortcutSettings = () => {
    setMoreOpen(false);
    setGlobalSettingsTab("terminal");
    if (!globalSettingsOpen) {
      toggleGlobalSettings();
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      className="relative z-header cy-no-select w-full shrink-0 border-t border-panel-border"
      onMouseDown={keepTerminalFocus}
      style={{
        background:
          "color-mix(in srgb, var(--vscode-terminal-background, var(--vscode-editor-background)) 92%, transparent)",
      }}
    >
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide px-1.5 py-1">
        {resolvedBarItems.map((item) =>
          item.kind === "ctrl" ? (
            <button
              key={item.id}
              type="button"
              className={`h-8 min-w-12 px-2 rounded-sm border text-xs shrink-0 transition-colors ${
                ctrlActive
                  ? "border-focus-border text-foreground bg-list-active-bg"
                  : "border-panel-border text-description-fg bg-transparent hover:text-foreground hover:bg-toolbar-hover-bg"
              }`}
              aria-pressed={ctrlActive}
              onClick={() => {
                setCtrlActive((active) => !active);
                requestAnimationFrame(focusTerminal);
              }}
            >
              Ctrl
            </button>
          ) : (
            <button
              key={item.id}
              type="button"
              className="h-8 min-w-10 px-2 rounded-sm border border-panel-border text-xs text-description-fg bg-transparent hover:text-foreground hover:bg-toolbar-hover-bg shrink-0 transition-colors"
              title={item.label}
              aria-label={item.label}
              onClick={() => sendKey(item.sequence)}
            >
              {item.glyph ?? item.label}
            </button>
          )
        )}

        {resolvedPopupItems.length > 0 && (
          <div className="ml-auto shrink-0">
            <button
              ref={moreButtonRef}
              type="button"
              className={`h-8 min-w-10 px-2 rounded-sm border text-xs shrink-0 transition-colors ${
                moreOpen
                  ? "border-focus-border text-foreground bg-list-active-bg"
                  : "border-panel-border text-description-fg bg-transparent hover:text-foreground hover:bg-toolbar-hover-bg"
              }`}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              title="More shortcuts"
              aria-label="More shortcuts"
              onClick={() => setMoreOpen((open) => !open)}
            >
              ...
            </button>

            <DropdownPortal
              ref={morePopupRef}
              isOpen={moreOpen}
              popupPos={morePopupPos}
              role="menu"
              className="cy-no-select"
            >
              <div
                role="presentation"
                className="flex min-h-0 flex-col"
                onMouseDown={keepTerminalFocus}
              >
                <div className="min-h-0 overflow-y-auto">
                  <div className="p-1 space-y-1">
                    {resolvedPopupItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        className="w-full px-2 py-1.5 text-left text-xs rounded-sm text-foreground hover:bg-list-hover-bg"
                        onClick={() => sendKey(item.sequence)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  className="w-full shrink-0 border-t border-dropdown-border px-2 py-1.5 text-left text-xs text-link-fg hover:bg-list-hover-bg"
                  onClick={openShortcutSettings}
                >
                  Add shortcuts...
                </button>
              </div>
            </DropdownPortal>
          </div>
        )}
      </div>
    </div>
  );
};
