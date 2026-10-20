import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  resolveOutputViewIdentity,
  useOutputViewIdentity,
  type OutputViewIdentityInput,
} from "@hooks/useOutputViewIdentity";

const history = (runRef: string | null): OutputViewIdentityInput => ({
  isViewingHistory: true,
  displayedRunRef: runRef,
});
const live = (runRef: string | null): OutputViewIdentityInput => ({
  isViewingHistory: false,
  displayedRunRef: runRef,
});

function renderViewIdentity(initial: OutputViewIdentityInput) {
  return renderHook(
    (input: OutputViewIdentityInput) => useOutputViewIdentity(input),
    { initialProps: initial }
  );
}

describe("useOutputViewIdentity", () => {
  it("keeps the key when a continuation promotes a run's history into its live view", () => {
    // Regression: sending a prompt that appends a step flipped the key from
    // the run to "live", which restarted the staged render from the top and
    // blanked the pane under the "Rendering output…" overlay.
    const { result, rerender } = renderViewIdentity(history("run-1"));
    const historyKey = result.current;

    rerender(live("run-1"));

    expect(result.current).toBe(historyKey);
  });

  it("changes the key when a live run is reopened as history", () => {
    const { result, rerender } = renderViewIdentity(history("run-1"));
    const firstKey = result.current;
    rerender(live("run-1"));

    // History of the same run is a fresh snapshot whose rows can size
    // differently from the live ones (e.g. diffs collapsed).
    rerender(history("run-1"));

    expect(result.current).not.toBe(firstKey);
  });

  it("changes the key when switching to another run or to live output of none", () => {
    const { result, rerender } = renderViewIdentity(history("run-1"));
    const keys = new Set([result.current]);

    rerender(history("run-2"));
    keys.add(result.current);
    rerender(live(null));
    keys.add(result.current);
    rerender(history("run-1"));
    keys.add(result.current);

    expect(keys.size).toBe(4);
  });

  it("treats leaving history for a different live run as a switch", () => {
    const { result, rerender } = renderViewIdentity(history("run-1"));
    const historyKey = result.current;

    rerender(live("run-2"));

    expect(result.current).not.toBe(historyKey);
  });

  it("returns the previous identity object when nothing changed", () => {
    const first = resolveOutputViewIdentity(null, history("run-1"));

    expect(resolveOutputViewIdentity(first, history("run-1"))).toBe(first);
  });
});
