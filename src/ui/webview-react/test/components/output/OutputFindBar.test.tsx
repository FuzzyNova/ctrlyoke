import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputFindBar } from "@components/output";
import type { OutputFindState } from "@hooks/useOutputFind";

function createState(overrides: Partial<OutputFindState> = {}): OutputFindState {
  return {
    isOpen: false,
    query: "",
    caseSensitive: false,
    currentMatch: 0,
    matchCount: 0,
    ...overrides,
  };
}

describe("OutputFindBar", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when closed", () => {
    render(
      <OutputFindBar
        state={createState()}
        onQueryChange={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCaseSensitive={vi.fn()}
        onClose={vi.fn()}
        onKeyDown={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("textbox", { name: /find in output/i })
    ).not.toBeInTheDocument();
  });

  it("keeps rendering long enough to play the exit animation", () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <OutputFindBar
        state={createState({ isOpen: true, query: "alpha", matchCount: 2, currentMatch: 1 })}
        onQueryChange={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCaseSensitive={vi.fn()}
        onClose={vi.fn()}
        onKeyDown={vi.fn()}
      />
    );

    const input = screen.getByRole("textbox", { name: /find in output/i });
    expect(input.closest("div")).toHaveClass("animate-output-find-enter");

    rerender(
      <OutputFindBar
        state={createState()}
        onQueryChange={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCaseSensitive={vi.fn()}
        onClose={vi.fn()}
        onKeyDown={vi.fn()}
      />
    );

    expect(
      screen.getByRole("textbox", { name: /find in output/i, hidden: true })
    ).toBeInTheDocument();
    expect(input.closest("div")).toHaveClass("animate-output-find-exit");

    vi.advanceTimersByTime(180);

    expect(
      screen.queryByRole("textbox", { name: /find in output/i })
    ).not.toBeInTheDocument();
  });
});
