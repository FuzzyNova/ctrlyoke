import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";

const infoMock = vi.hoisted(() => vi.fn());
vi.mock("@utils/logger", () => ({
  WebviewLog: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: infoMock,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { useWorkflowStore } from "@store/workflowStore";
import {
  notePanelMessage,
  startPanelMemorySampler,
} from "@utils/memorySampler";

function entries(count: number): OrderedHistoryEntry[] {
  return Array.from({ length: count }, () => ({}) as OrderedHistoryEntry);
}

describe("memorySampler", () => {
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    infoMock.mockClear();
    useWorkflowStore.setState({
      liveOrderedEntries: [],
      liveActivityEntries: [],
      historyOutputs: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
    });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("logs a baseline, then only real growth with the heavy messages in between", () => {
    stop = startPanelMemorySampler();
    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock.mock.calls[0][0]).toMatch(/\[PanelMemory\].*liveEntries=0/);

    useWorkflowStore.setState({ liveOrderedEntries: entries(10) });
    vi.advanceTimersByTime(15_000);
    expect(infoMock).toHaveBeenCalledTimes(1);

    notePanelMessage({
      type: MESSAGE_TYPES.RUN_VIEW_LOADED,
      history: { orderedEntries: entries(4868), activityEntries: [] },
    });
    notePanelMessage({ type: MESSAGE_TYPES.READY });
    useWorkflowStore.setState({ liveOrderedEntries: entries(4868) });
    vi.advanceTimersByTime(15_000);

    expect(infoMock).toHaveBeenCalledTimes(2);
    const line = infoMock.mock.calls[1][0] as string;
    expect(line).toMatch(/liveEntries=4868/);
    expect(line).toMatch(/runViewLoaded historyEntries=4868/);
    expect(line).not.toMatch(new RegExp(MESSAGE_TYPES.READY));
  });
});
