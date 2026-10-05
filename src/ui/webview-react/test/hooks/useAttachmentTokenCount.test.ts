import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachmentTokenCount } from "@hooks/useAttachmentTokenCount";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { useUiStore } from "@store/uiStore";
import { decodePriorContextTokenRef } from "@root/utils/FileReferenceParser";
import { parseMergedPriorContextBody } from "@root/utils/PriorContextMerge";

describe("useAttachmentTokenCount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (getVsCodeApi().postMessage as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    useUiStore.setState({ displayedViewAddress: null });
  });

  it("preserves quoting and symbol kinds in attachment token requests", () => {
    const references = [
      '@"docs/my notes.md"',
      '#selection:"src/my file.ts":1-5',
      '#sym.class:"src/a b.ts":Foo:3-9',
    ];
    renderHook(() => useAttachmentTokenCount(references.join(" ")));

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS,
      references,
    });
  });

  it("requests prior-context counts again when the displayed run changes", () => {
    const address = (runRef: string) => ({
      kind: "run" as const,
      workflowKey: "workflow-1" as never,
      runRef: runRef as never,
    });
    useUiStore.setState({ displayedViewAddress: address("run-1") });
    renderHook(() => useAttachmentTokenCount("$previous", 2));

    act(() => {
      vi.advanceTimersByTime(250);
    });
    const firstRequest = (
      getVsCodeApi().postMessage as ReturnType<typeof vi.fn>
    ).mock.calls[0][0] as { references: string[] };
    expect(firstRequest).toMatchObject({
      type: MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS,
      references: [expect.stringContaining("previous")],
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
            counts: { [firstRequest.references[0]]: 100 },
          },
        })
      );
    });

    (getVsCodeApi().postMessage as ReturnType<typeof vi.fn>).mockClear();
    act(() => {
      useUiStore.setState({ displayedViewAddress: address("run-2") });
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS,
      references: [firstRequest.references[0]],
    });
  });

  it("combines overlapping previous references into one three-item preview request", () => {
    renderHook(() => useAttachmentTokenCount("$previous $previous:3", 5));

    act(() => {
      vi.advanceTimersByTime(250);
    });

    const request = (getVsCodeApi().postMessage as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { references: string[] };
    expect(request.references).toHaveLength(1);
    const decoded = decodePriorContextTokenRef(request.references[0]);
    expect(decoded).not.toBeNull();
    expect(parseMergedPriorContextBody(decoded!.body)).toEqual([
      { previous: 3 },
    ]);
  });
});
