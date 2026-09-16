import { useState, useCallback } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";
import { writeClipboardText } from "@utils/stepClipboard";
import { sendMessage } from "./useMessageHandler";
import { MESSAGE_TYPES, TERMINAL_SESSION_STATUS } from "../types/messages";
import type { TerminalSession } from "@store/terminalStore";
import { terminalRegistry } from "../terminalRegistry";

interface UseTerminalContextMenuOptions {
  workflowId: string;
  activeSession: TerminalSession | null;
  /** True when `activeSession` is the live PTY a currently-running step is driving. */
  isSessionInUse: boolean;
  onClose: (session: TerminalSession) => void;
}

export function useTerminalContextMenu({
  workflowId,
  activeSession,
  isSessionInUse,
  onClose,
}: UseTerminalContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const openContextMenu = useCallback(
    (x: number, y: number) => {
      const sessionId = activeSession?.id ?? null;
      const isSessionRunning =
        activeSession?.status === TERMINAL_SESSION_STATUS.RUNNING;

      // Capture xterm's selection at menu-open time before any click clears it
      const selectedText = sessionId
        ? (terminalRegistry.get(workflowId, sessionId)?.term.getSelection() ??
          "")
        : "";

      const inputDisabled = !sessionId || !isSessionRunning;
      const inputDisabledTitle = !sessionId
        ? "No active terminal"
        : "Terminal is not running";

      const closeDisabled = !activeSession || isSessionInUse;
      const closeDisabledTitle = isSessionInUse
        ? "Cannot close a running step terminal"
        : undefined;

      setContextMenu({
        x,
        y,
        items: [
          {
            label: "Copy",
            icon: "codicon-copy",
            disabled: false,
            onClick: () => {
              if (selectedText) void writeClipboardText(selectedText);
            },
          },
          {
            label: "Paste",
            icon: "codicon-clippy",
            disabled: inputDisabled,
            disabledTitle: inputDisabledTitle,
            onClick: () => {
              if (!sessionId || inputDisabled) return;
              void navigator.clipboard.readText().then((text) => {
                if (!text) return;
                const entry = terminalRegistry.get(workflowId, sessionId);
                entry?.term.paste(text);
              });
            },
          },
          { type: "divider" },
          {
            label: "Clear",
            icon: "codicon-clear-all",
            disabled: inputDisabled,
            disabledTitle: inputDisabledTitle,
            onClick: () => {
              if (!sessionId || inputDisabled) return;
              sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, {
                workflowId,
                sessionId,
                data: "\x0c",
              });
            },
          },
          {
            label: "Interrupt",
            icon: "codicon-stop-circle",
            disabled: inputDisabled,
            disabledTitle: inputDisabledTitle,
            onClick: () => {
              if (!sessionId || inputDisabled) return;
              sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, {
                workflowId,
                sessionId,
                data: "\x03",
              });
            },
          },
          { type: "divider" },
          {
            label: "Close Terminal",
            icon: "codicon-trash",
            disabled: closeDisabled,
            disabledTitle: closeDisabledTitle,
            onClick: () => {
              if (!activeSession || closeDisabled) return;
              onClose(activeSession);
            },
          },
        ],
      });
    },
    [workflowId, activeSession, isSessionInUse, onClose]
  );

  const terminalContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openContextMenu, terminalContextMenuPortal };
}
