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

  it("reissues lost requests and retires refs after the attempt cap", () => {
    const { result } = renderHook(() =>
      useAttachmentTokenCount("@src/extension.ts")
    );
    const postMessage = getVsCodeApi().postMessage as ReturnType<typeof vi.fn>;

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(postMessage).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(postMessage).toHaveBeenCalledTimes(3);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBeGreaterThan(0);
    expect(postMessage).toHaveBeenCalledTimes(3);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(postMessage).toHaveBeenCalledTimes(3);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(postMessage).toHaveBeenCalledTimes(3);
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
      { context: "previous", detail: "full" },
      { context: { previous: 3 }, detail: "full" },
    ]);
  });

  // The module cache outlives each test, so every test below uses its own paths.
  const respond = (
    counts: Record<string, number>,
    sourceDefinitionPath?: string
  ) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
            counts,
            ...(sourceDefinitionPath !== undefined && { sourceDefinitionPath }),
          },
        })
      );
    });

  it("re-renders with an ordinary file count as soon as it arrives", () => {
    const { result } = renderHook(() =>
      useAttachmentTokenCount("@src/arrives.ts")
    );
    const rawOnly = result.current;

    respond({ "@src/arrives.ts": 500 });

    expect(result.current).toBe(rawOnly + 500);
  });

  it("sends the source file with the request when one is given", () => {
    renderHook(() =>
      useAttachmentTokenCount("@./sent.md", 0, "prompts/a.prompt.md")
    );

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS,
      references: ["@./sent.md"],
      sourceDefinitionPath: "prompts/a.prompt.md",
    });
  });

  it("caches a ./ reference per source file but shares plain references", () => {
    const text = "@./notes.md @src/shared.ts";
    const inA = renderHook(() =>
      useAttachmentTokenCount(text, 0, "a/one.prompt.md")
    );
    const inB = renderHook(() =>
      useAttachmentTokenCount(text, 0, "b/two.prompt.md")
    );
    const header = renderHook(() => useAttachmentTokenCount(text));
    const rawOnly = header.result.current;

    respond({ "@./notes.md": 10, "@src/shared.ts": 1 }, "a/one.prompt.md");
    respond({ "@./notes.md": 200 }, "b/two.prompt.md");

    expect(inA.result.current).toBe(rawOnly + 11);
    expect(inB.result.current).toBe(rawOnly + 201);
    // No base-less count for ./notes.md has arrived for the header yet.
    expect(header.result.current).toBe(rawOnly + 1);

    respond({ "@./notes.md": 3000 });
    expect(header.result.current).toBe(rawOnly + 3001);
    expect(inA.result.current).toBe(rawOnly + 11);
  });

  it("keys ./ line-range and symbol references by source file too", () => {
    const text = "#selection:./range.ts:1-2 #sym:../sym.ts:run:3-4";
    const inA = renderHook(() =>
      useAttachmentTokenCount(text, 0, "a/x.prompt.md")
    );
    const header = renderHook(() => useAttachmentTokenCount(text));
    const rawOnly = header.result.current;

    respond(
      { "#selection:./range.ts:1-2": 5, "#sym:../sym.ts:run:3-4": 7 },
      "a/x.prompt.md"
    );

    expect(inA.result.current).toBe(rawOnly + 12);
    expect(header.result.current).toBe(rawOnly);
  });

  it("keeps each reference's summary detail in the preview request", () => {
    renderHook(() =>
      useAttachmentTokenCount("$previous:summary:3 $previous:summary:3", 5)
    );

    act(() => {
      vi.advanceTimersByTime(250);
    });

    const request = (getVsCodeApi().postMessage as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as { references: string[] };
    const decoded = decodePriorContextTokenRef(request.references[0]);
    expect(parseMergedPriorContextBody(decoded!.body)).toEqual([
      { context: { previous: 3 }, detail: "summary" },
    ]);
  });
});
