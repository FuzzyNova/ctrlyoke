import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { useOutputFind } from "@hooks/useOutputFind";
import type { OutputRenderRow } from "@utils/outputRows";

const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;

function makeRows(): OutputRenderRow[] {
  return [
    {
      key: "row-1",
      rowKind: "prompt",
      target,
      text: "alpha",
      estimateSize: 24,
    },
    {
      key: "row-2",
      rowKind: "prompt",
      target,
      text: "beta alpha",
      estimateSize: 24,
    },
  ];
}

describe("useOutputFind", () => {
  const onRevealRow = vi.fn();
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;

  beforeEach(() => {
    onRevealRow.mockReset();
    originalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof window.requestAnimationFrame;
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it("opens and closes the find bar", () => {
    const rows = makeRows();
    const { result } = renderHook(() => useOutputFind(rows, onRevealRow));

    act(() => {
      result.current.open("alpha");
    });

    expect(result.current.state.isOpen).toBe(true);
    expect(result.current.state.query).toBe("alpha");
    expect(result.current.state.matchCount).toBe(2);

    act(() => {
      result.current.close();
    });

    expect(result.current.state.isOpen).toBe(false);
    expect(result.current.state.query).toBe("");
    expect(result.current.state.matchCount).toBe(0);
    expect(result.current.activeMatch).toBeNull();
  });

  it("wraps navigation when moving past the last match", () => {
    const rows = makeRows();
    const { result } = renderHook(() => useOutputFind(rows, onRevealRow));

    act(() => {
      result.current.open("alpha");
    });

    expect(result.current.state.currentMatch).toBe(1);

    act(() => {
      result.current.navigate(1);
    });

    expect(result.current.state.currentMatch).toBe(2);
    expect(onRevealRow).toHaveBeenLastCalledWith(1);

    act(() => {
      result.current.navigate(1);
    });

    expect(result.current.state.currentMatch).toBe(1);
    expect(onRevealRow).toHaveBeenLastCalledWith(0);
  });

  it("opens and searches when an external query is provided", async () => {
    const rows = makeRows();
    const { result, rerender } = renderHook(
      ({ externalQuery }: { externalQuery: string | null }) =>
        useOutputFind(rows, onRevealRow, externalQuery),
      {
        initialProps: { externalQuery: null as string | null },
      }
    );

    rerender({ externalQuery: "alpha" });

    await waitFor(() => {
      expect(result.current.state.isOpen).toBe(true);
      expect(result.current.state.query).toBe("alpha");
      expect(result.current.state.matchCount).toBe(2);
    });
  });
});
