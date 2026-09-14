import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useActiveInteractiveSession } from "@hooks/useActiveInteractiveSession";
import { useTerminalStore } from "@store/terminalStore";
import {
  HARNESS_IDS,
  SESSION_KINDS,
  TERMINAL_SESSION_STATUS,
} from "@root/types/DashboardConstants";

describe("useActiveInteractiveSession", () => {
  beforeEach(() => {
    useTerminalStore.setState({ sessions: {}, activeSessionIds: {} });
  });

  it.each([
    ["a shell session", SESSION_KINDS.SHELL, TERMINAL_SESSION_STATUS.RUNNING],
    ["a completed AI session", SESSION_KINDS.AI_CLI, TERMINAL_SESSION_STATUS.COMPLETED],
  ] as const)("rejects %s", (_label, kind, status) => {
    useTerminalStore.setState({
      sessions: {
        "workflow-1": [
          {
            id: "session-1",
            workflowId: "workflow-1",
            stepName: "Step 1",
            kind,
            harnessId: HARNESS_IDS.CODEX_CLI,
            status,
            isController: true,
          },
        ],
      },
      activeSessionIds: { "workflow-1": "session-1" },
    });

    const { result } = renderHook(() =>
      useActiveInteractiveSession("workflow-1")
    );

    expect(result.current).toBeUndefined();
  });
});
