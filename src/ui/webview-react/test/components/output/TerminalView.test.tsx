import React from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkflowStore } from "@store/workflowStore";
import { terminalRegistry } from "@/terminalRegistry";
import {
  MESSAGE_TYPES,
  SESSION_KINDS,
  TERMINAL_SESSION_STATUS,
} from "@/types/messages";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
}));

vi.mock("@hooks/useMessageHandler", () => ({
  sendMessage: sendMessageMock,
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => null,
}));

vi.mock("@hooks/useMobileTerminalBar", () => ({
  useMobileTerminalBar: () => ({ shouldShow: false }),
}));

vi.mock("@hooks/useLongPress", () => ({
  useLongPress: () => ({}),
}));

vi.mock("@hooks/useTerminalContextMenu", () => ({
  useTerminalContextMenu: () => ({
    openContextMenu: vi.fn(),
    terminalContextMenuPortal: null,
  }),
}));

import {
  getTerminalStepLabel,
  TerminalView,
} from "@components/output/TerminalView";

describe("TerminalView terminal labels", () => {
  it("uses the final-step name instead of numbering a signed final step", () => {
    expect(
      getTerminalStepLabel({
        id: "final-step-session",
        workflowId: "workflow-final-step",
        stepName: "Final review",
        stepIndex: -1,
        kind: SESSION_KINDS.AI_CLI,
        status: TERMINAL_SESSION_STATUS.RUNNING,
        isController: true,
      })
    ).toBe("Final review");
  });
});

describe("TerminalView empty-pane viewport hint", () => {
  const measureViewportSpy = vi.spyOn(
    terminalRegistry,
    "measureViewportContainer"
  );
  const releaseViewportMeasurementSpy = vi.spyOn(
    terminalRegistry,
    "releaseViewportMeasurement"
  );

  beforeEach(() => {
    cleanup();
    useTerminalStore.setState({
      sessions: {},
      activeSessionIds: {},
      activeTerminalWorkflows: [],
    });
    useUiStore.getState().resetUi();
    useSettingsStore.getState().resetSettings();
    useWorkflowStore.getState().resetWorkflow();
    sendMessageMock.mockReset();
    measureViewportSpy.mockReset();
    releaseViewportMeasurementSpy.mockReset();
    measureViewportSpy.mockReturnValue({
      cols: 64,
      rows: 20,
      proposedCols: 64,
      proposedRows: 20,
      mode: "controller",
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 640,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 360,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("publishes a viewport hint from the empty terminal pane before any session exists", async () => {
    render(<TerminalView workflowId="workflow-empty-pane" />);

    await waitFor(() => {
      expect(measureViewportSpy).toHaveBeenCalled();
      expect(sendMessageMock).toHaveBeenCalledWith(
        MESSAGE_TYPES.TERMINAL_VIEWPORT_HINT,
        {
          workflowId: "workflow-empty-pane",
          cols: 64,
          rows: 20,
        }
      );
    });
  });
});
