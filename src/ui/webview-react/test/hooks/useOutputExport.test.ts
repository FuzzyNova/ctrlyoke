import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOutputExport } from "@hooks/useOutputExport";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import type { OutputMessage } from "@utils/outputProjection";
import { FINAL_STEP_PHASES } from "@/types/messages";
import {
  OUTPUT_HISTORY_KINDS,
  OUTPUT_MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";

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

const allMessages = [1, 2, 3].map((timestamp) => ({
  ...makeCliMessage(0, "activity slice", timestamp),
  isActivity: true,
}));

const liveOrderedEntries: OrderedHistoryEntry[] = [0, 1, 2].map((index) => ({
  kind: OUTPUT_HISTORY_KINDS.CLI,
  target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: index },
  timestampMs: index + 1,
  sequence: index + 1,
  attemptIndex: 0,
  prompt: ["one", "two", "three"][index],
  cliOutput: {
    structured: {
      events: [
        {
          type: "text",
          data: { text: `output ${["one", "two", "three"][index]}` },
        },
      ],
      metadata: {},
    },
    elapsed: 1,
    isStreaming: false,
  },
}));

function renderExportHook({
  isViewingHistory = false,
  historyOrderedEntries,
  liveEntries = liveOrderedEntries,
  steps = [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }],
}: {
  isViewingHistory?: boolean;
  historyOrderedEntries?: OrderedHistoryEntry[];
  liveEntries?: OrderedHistoryEntry[];
  steps?: Array<{ prompt: string; name?: string }>;
} = {}) {
  return renderHook(() =>
    useOutputExport({
      allMessages,
      currentStep: 3,
      executionState: "completed",
      fileName: "workflow",
      finalStep: null,
      historyOrderedEntries,
      liveOrderedEntries: isViewingHistory ? undefined : liveEntries,
      hiddenTargetKeys: ["queue:1"],
      isViewingHistory,
      steps,
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

  it("exports one aggregate section for live activity slices", () => {
    const { result } = renderExportHook({
      liveEntries: [liveOrderedEntries[0]],
    });

    act(() => result.current.confirmExport());

    const message = postMessage.mock.calls[0][0] as { content: string };
    expect(message.content.match(/^## Step 1/m)).toHaveLength(1);
    expect(message.content).toContain("output one");
    expect(message.content).not.toContain("activity slice");
    expect(result.current.totalCliSteps).toBe(1);
  });

  it.each([false, true])(
    "labels exported steps with their configured names (history: %s)",
    (isViewingHistory) => {
      const { result } = renderExportHook({
        isViewingHistory,
        historyOrderedEntries: isViewingHistory
          ? liveOrderedEntries
          : undefined,
        steps: [
          { prompt: "one", name: "Refactor parser" },
          { prompt: "two" },
          { prompt: "three" },
        ],
      });

      act(() => result.current.confirmExport());

      const message = postMessage.mock.calls[0][0] as { content: string };
      expect(message.content).toMatch(/^## Step 1: Refactor parser — /m);
    }
  );

  it("keeps history export on the aggregate ordered entries", () => {
    const { result } = renderExportHook({
      isViewingHistory: true,
      historyOrderedEntries: liveOrderedEntries,
    });

    act(() => result.current.confirmExport());

    const message = postMessage.mock.calls[0][0] as { content: string };
    expect(message.content.match(/^## Step 1/m)).toHaveLength(1);
    expect(message.content).toContain("output one");
    expect(message.content).not.toContain("activity slice");
  });
});
