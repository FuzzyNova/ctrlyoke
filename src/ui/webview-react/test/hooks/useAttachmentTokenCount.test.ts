import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachmentTokenCount } from "@hooks/useAttachmentTokenCount";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";

describe("useAttachmentTokenCount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (getVsCodeApi().postMessage as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
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
});
