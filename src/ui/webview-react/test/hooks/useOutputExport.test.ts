import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOutputExport } from "@hooks/useOutputExport";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import type { OutputMessage } from "@utils/outputProjection";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { OUTPUT_MESSAGE_TYPES } from "@root/types/DashboardConstants";

function makeCliMessage(
  index: number,
  response: string,
  timestamp: number
): OutputMessage {
  return {
    type: OUTPUT_MESSAGE_TYPES.CLI,
    target: { kind: FINAL_STEP_PHASES.QUEUE, index },
    timestamp,
    data: {
      structured: {
        events: [{ type: "text", data: { text: response } }],
        metadata: {},
      },
      elapsed: 1,
      isStreaming: false,
    },
  };
}

const allMessages = [
  makeCliMessage(0, "output one", 1),
  makeCliMessage(1, "output two", 2),
  makeCliMessage(2, "output three", 3),
];

function renderExportHook() {
  return renderHook(() =>
    useOutputExport({
      allMessages,
      currentStep: 3,
      executionState: "completed",
      fileName: "workflow",
      finalStep: null,
      historyOrderedEntries: undefined,
      hiddenTargetKeys: ["queue:1"],
      isViewingHistory: false,
      steps: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }],
      totalSteps: 3,
    })
  );
}

describe("useOutputExport", () => {
  const postMessage = getVsCodeApi().postMessage as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postMessage.mockClear();
  });

  it("pre-fills the range with the visible steps when the modal opens", () => {
    const { result } = renderExportHook();

    expect(result.current.stepRange).toBe("");
    act(() => result.current.openModal());

    expect(result.current.stepRange).toBe("1,3");
  });

  it("lets a widened range override the active filter", () => {
    const { result } = renderExportHook();

    act(() => result.current.openModal());
    act(() => result.current.updateStepRange("1-3"));
    act(() => result.current.confirmExport());

    const message = postMessage.mock.calls[0][0] as {
      content: string;
    };
    expect(message.content).toContain("output two");
  });
});
