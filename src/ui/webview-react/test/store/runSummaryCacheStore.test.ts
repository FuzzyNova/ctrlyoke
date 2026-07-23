import { describe, it, expect, vi, beforeEach } from "vitest";
import { useRunSummaryCacheStore } from "@store/runSummaryCacheStore";
import { MESSAGE_TYPES } from "@/types/messages";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";

const postMessageSpy = vi.fn();

const WORKFLOW_KEY = "wf-1" as never;

function summary(runId: number, runRef: string): RunSummary {
  return {
    workflowKey: WORKFLOW_KEY,
    runRef: runRef as never,
    runId,
    startedAt: runId * 1000,
    executionState: "completed" as never,
    definitionRevision: 1,
    stepCount: 1,
    hasMixedHarnesses: false,
    hasMixedModels: false,
  };
}

beforeEach(() => {
  useRunSummaryCacheStore.setState({ entries: {} });
  (
    window.vscodeApi as unknown as { postMessage: ReturnType<typeof vi.fn> }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

describe("runSummaryCacheStore.ensureRunSummaries", () => {
  it("sends LOAD_RUN_SUMMARIES and marks the entry loading", () => {
    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY);

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.LOAD_RUN_SUMMARIES,
        workflowKey: WORKFLOW_KEY,
        requestId: expect.any(String),
      })
    );
    expect(
      useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY]?.status
    ).toBe("loading");
  });

  it("dedupes a second call while a request is already in flight", () => {
    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY);
    postMessageSpy.mockClear();
    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY);

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it("does not re-fetch when the cached entry is at least as fresh as knownLastModifiedAt", () => {
    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY);
    const requestId =
      useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY]!.requestId;
    useRunSummaryCacheStore.getState().resolveRunSummaries({
      requestId,
      workflowKey: WORKFLOW_KEY,
      descriptorRevision: 1,
      lastModifiedAt: 500,
      runSummaries: [summary(1, "run-1")],
    });
    postMessageSpy.mockClear();

    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY, 100);

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it("re-fetches when the cached entry is older than knownLastModifiedAt", () => {
    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY);
    const requestId =
      useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY]!.requestId;
    useRunSummaryCacheStore.getState().resolveRunSummaries({
      requestId,
      workflowKey: WORKFLOW_KEY,
      descriptorRevision: 1,
      lastModifiedAt: 100,
      runSummaries: [summary(1, "run-1")],
    });
    postMessageSpy.mockClear();

    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY, 500);

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.LOAD_RUN_SUMMARIES })
    );
  });
});

describe("runSummaryCacheStore.resolveRunSummaries", () => {
  it("ignores a stale reply to a superseded in-flight request", () => {
    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY);
    useRunSummaryCacheStore.getState().resolveRunSummaries({
      requestId: "some-other-stale-request-id",
      workflowKey: WORKFLOW_KEY,
      descriptorRevision: 1,
      lastModifiedAt: 100,
      runSummaries: [summary(1, "run-1")],
    });

    expect(
      useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY]?.status
    ).toBe("loading");
  });

  it("accepts an unsolicited push (e.g. after a delete) even without a matching in-flight request", () => {
    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY);
    const requestId =
      useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY]!.requestId;
    useRunSummaryCacheStore.getState().resolveRunSummaries({
      requestId,
      workflowKey: WORKFLOW_KEY,
      descriptorRevision: 1,
      lastModifiedAt: 100,
      runSummaries: [summary(2, "run-2"), summary(1, "run-1")],
    });

    // Server-pushed refresh after e.g. a delete, correlated to no request the
    // client itself issued.
    useRunSummaryCacheStore.getState().resolveRunSummaries({
      requestId: "delete-refresh-123",
      workflowKey: WORKFLOW_KEY,
      descriptorRevision: 2,
      lastModifiedAt: 200,
      runSummaries: [summary(1, "run-1")],
    });

    const entry = useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY];
    expect(entry?.status).toBe("loaded");
    expect(entry?.runSummaries).toHaveLength(1);
    expect(entry?.runSummaries[0].runId).toBe(1);
  });
});

describe("runSummaryCacheStore.resolveRunSummariesError", () => {
  it("marks the awaiting entry as errored", () => {
    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY);
    const requestId =
      useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY]!.requestId;

    useRunSummaryCacheStore
      .getState()
      .resolveRunSummariesError(requestId, "No workspace folder is open");

    const entry = useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY];
    expect(entry?.status).toBe("error");
    expect(entry?.error).toBe("No workspace folder is open");
  });
});

describe("runSummaryCacheStore.invalidate", () => {
  it("drops the cached entry so the next ensureRunSummaries call re-fetches", () => {
    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY);
    const requestId =
      useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY]!.requestId;
    useRunSummaryCacheStore.getState().resolveRunSummaries({
      requestId,
      workflowKey: WORKFLOW_KEY,
      descriptorRevision: 1,
      lastModifiedAt: 500,
      runSummaries: [summary(1, "run-1")],
    });

    useRunSummaryCacheStore.getState().invalidate(WORKFLOW_KEY);
    expect(
      useRunSummaryCacheStore.getState().entries[WORKFLOW_KEY]
    ).toBeUndefined();

    useRunSummaryCacheStore.getState().ensureRunSummaries(WORKFLOW_KEY, 500);
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.LOAD_RUN_SUMMARIES })
    );
  });
});
