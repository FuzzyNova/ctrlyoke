import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { sendMessage } from "@hooks/useMessageHandler";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@/types/messages";
import { terminalRegistry } from "../../terminalRegistry";

interface TerminalControlBarProps {
  workflowId: string;
  sessionId: string;
}

interface Shortcut {
  label: string;
  sequence: string;
}

interface NavigatorWithVirtualKeyboard extends Navigator {
  virtualKeyboard?: {
    overlaysContent: boolean;
  };
}

const BUILT_IN_SHORTCUTS: Shortcut[] = [
  { label: "Shift+Tab", sequence: "\x1b[Z" },
  { label: "Ctrl+C", sequence: "\x03" },
  { label: "Ctrl+Z", sequence: "\x1a" },
  { label: "Ctrl+L", sequence: "\x0c" },
  { label: "Ctrl+R", sequence: "\x12" },
  { label: "Ctrl+A", sequence: "\x01" },
];

const PRIMARY_KEYS: Shortcut[] = [
  { label: "Esc", sequence: "\x1b" },
  { label: "Tab", sequence: "\x09" },
  { label: "Up", sequence: "\x1b[A" },
  { label: "Down", sequence: "\x1b[B" },
  { label: "Left", sequence: "\x1b[D" },
  { label: "Right", sequence: "\x1b[C" },
  { label: "Enter", sequence: "\r" },
];

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

function useKeyboardInset(): string {
  const [visualViewportInset, setVisualViewportInset] = useState(0);

  useEffect(() => {
    const virtualKeyboard = (navigator as NavigatorWithVirtualKeyboard)
      .virtualKeyboard;
    if (virtualKeyboard) {
      const previous = virtualKeyboard.overlaysContent;
      virtualKeyboard.overlaysContent = true;
      return () => {
        virtualKeyboard.overlaysContent = previous;
      };
    }
    return undefined;
  }, []);

  useEffect(() => {
    const virtualKeyboard = (navigator as NavigatorWithVirtualKeyboard)
      .virtualKeyboard;
    if (virtualKeyboard) return;
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;

    const updateInset = () => {
      setVisualViewportInset(
        Math.max(
          0,
          window.innerHeight - visualViewport.offsetTop - visualViewport.height
        )
      );
    };

    updateInset();
    visualViewport.addEventListener("resize", updateInset);
    visualViewport.addEventListener("scroll", updateInset);
    return () => {
      visualViewport.removeEventListener("resize", updateInset);
      visualViewport.removeEventListener("scroll", updateInset);
    };
  }, []);

  return `calc(env(keyboard-inset-height, 0px) + ${visualViewportInset}px)`;
}

export const TerminalControlBar: React.FC<TerminalControlBarProps> = ({
  workflowId,
  sessionId,
}) => {
  const [ctrlActive, setCtrlActive] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const keyboardInset = useKeyboardInset();
  const customShortcuts = useSettingsStore(
    (s) =>
      s.fullGlobalSettings?.settings.terminal.mobileCustomShortcuts ??
      s.globalSettings.terminal?.mobileCustomShortcuts ??
      []
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

  useEffect(() => {
    if (!moreOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
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
      ref={moreRef}
      className="sticky bottom-0 z-20 w-full border-t border-panel-border"
      style={{
        paddingBottom: keyboardInset,
        background:
          "color-mix(in srgb, var(--vscode-terminal-background, var(--vscode-editor-background)) 92%, transparent)",
      }}
    >
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide px-1.5 py-1">
        <button
          type="button"
          className={`h-8 min-w-12 px-2 rounded border text-xs shrink-0 transition-colors ${
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

        {PRIMARY_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="h-8 min-w-10 px-2 rounded border border-panel-border text-xs text-description-fg bg-transparent hover:text-foreground hover:bg-toolbar-hover-bg shrink-0 transition-colors"
            title={key.label}
            aria-label={key.label}
            onClick={() => sendKey(key.sequence)}
          >
            {key.label === "Up"
              ? "↑"
              : key.label === "Down"
                ? "↓"
                : key.label === "Left"
                  ? "←"
                  : key.label === "Right"
                    ? "→"
                    : key.label === "Enter"
                      ? "⏎"
                      : key.label}
          </button>
        ))}

        <div className="shrink-0">
          <button
            type="button"
            className={`h-8 min-w-10 px-2 rounded border text-xs shrink-0 transition-colors ${
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
        </div>
      </div>

      {moreOpen && (
        <div
          role="menu"
          className="absolute right-1 bottom-full mb-1 w-48 max-h-[60vh] overflow-y-auto rounded border border-panel-border bg-editor-bg shadow-lg"
        >
          <div className="p-1 space-y-1">
            {BUILT_IN_SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.label}
                type="button"
                role="menuitem"
                className="w-full px-2 py-1.5 text-left text-xs rounded text-foreground hover:bg-list-hover-bg"
                onClick={() => sendKey(shortcut.sequence)}
              >
                {shortcut.label}
              </button>
            ))}

            {usableCustomShortcuts.length > 0 && (
              <div className="border-t border-panel-border pt-1 mt-1">
                {usableCustomShortcuts.map((shortcut, index) => (
                  <button
                    key={`${shortcut.label}-${index}`}
                    type="button"
                    role="menuitem"
                    className="w-full px-2 py-1.5 text-left text-xs rounded text-foreground hover:bg-list-hover-bg"
                    onClick={() =>
                      sendKey(decodeEscapeSequence(shortcut.sequence))
                    }
                  >
                    {shortcut.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className="w-full border-t border-panel-border px-2 py-1.5 text-left text-xs text-link-fg hover:bg-list-hover-bg"
            onClick={openShortcutSettings}
          >
            Add shortcuts...
          </button>
        </div>
      )}
    </div>
  );
};
