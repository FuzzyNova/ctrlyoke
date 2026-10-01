import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { useOutputFind } from "@hooks/useOutputFind";
import type { OutputRenderRow } from "@utils/outputRows";
import {
  CLI_EVENT_TYPES,
  OUTPUT_ROW_KINDS,
} from "@root/types/DashboardConstants";

const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;

function makeRows(): OutputRenderRow[] {
  return [
    {
      key: "row-1",
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      target,
      text: "alpha",
      estimateSize: 24,
    },
    {
      key: "row-2",
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      target,
      text: "beta alpha",
      estimateSize: 24,
    },
  ];
}

describe("useOutputFind", () => {
  const onRevealMatch = vi.fn();
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;

  beforeEach(() => {
    onRevealMatch.mockReset();
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
    const { result } = renderHook(() => useOutputFind(rows, onRevealMatch));

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

  it("finds the capped head and reports that truncated tails may be missed", () => {
    const rows: OutputRenderRow[] = [
      {
        key: "capped-bash",
        rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
        target,
        event: {
          type: CLI_EVENT_TYPES.BASH_COMMAND,
          data: {
            command: "cat log",
            output: "visible head",
            outputTruncated: true,
            outputTotalBytes: 500_000,
          },
          outputTruncated: true,
          outputTotalBytes: 500_000,
        },
        eventIndex: 0,
        attemptIndex: 0,
        runIndex: 0,
        rawTextOutput: false,
        hideDiff: false,
        estimateSize: 40,
      },
    ];
    const { result } = renderHook(() => useOutputFind(rows, onRevealMatch));

    act(() => result.current.open("head"));
    expect(result.current.state.matchCount).toBe(1);
    expect(result.current.state.mayMissMatches).toBe(true);

    act(() => result.current.search("tail"));
    expect(result.current.state.matchCount).toBe(0);
    expect(result.current.state.mayMissMatches).toBe(true);
  });

  it("wraps navigation when moving past the last match", () => {
    const rows = makeRows();
    const { result } = renderHook(() => useOutputFind(rows, onRevealMatch));

    act(() => {
      result.current.open("alpha");
    });

    expect(result.current.state.currentMatch).toBe(1);

    act(() => {
      result.current.navigate(1);
    });

    expect(result.current.state.currentMatch).toBe(2);
    expect(onRevealMatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowIndex: 1, start: 5, end: 10 })
    );

    act(() => {
      result.current.navigate(1);
    });

    expect(result.current.state.currentMatch).toBe(1);
    expect(onRevealMatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowIndex: 0, start: 0, end: 5 })
    );
  });

  it("reveals distinct matches within the same row", () => {
    const rows: OutputRenderRow[] = [
      {
        key: "row-1",
        rowKind: OUTPUT_ROW_KINDS.PROMPT,
        target,
        text: "alpha beta alpha",
        estimateSize: 24,
      },
    ];
    const { result } = renderHook(() => useOutputFind(rows, onRevealMatch));

    act(() => {
      result.current.open("alpha");
    });

    expect(onRevealMatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowIndex: 0, start: 0, end: 5 })
    );

    act(() => {
      result.current.navigate(1);
    });

    expect(onRevealMatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowIndex: 0, start: 11, end: 16 })
    );
  });

  it("opens and searches when an external request is provided", async () => {
    const rows = makeRows();
    const { result, rerender } = renderHook(
      ({
        externalRequest,
      }: {
        externalRequest: {
          query: string;
          preferredTarget?: typeof target;
        } | null;
      }) => useOutputFind(rows, onRevealMatch, externalRequest),
      {
        initialProps: {
          externalRequest: null as {
            query: string;
            preferredTarget?: typeof target;
          } | null,
        },
      }
    );

    rerender({ externalRequest: { query: "alpha", preferredTarget: target } });

    await waitFor(() => {
      expect(result.current.state.isOpen).toBe(true);
      expect(result.current.state.query).toBe("alpha");
      expect(result.current.state.matchCount).toBe(2);
    });
  });
});
