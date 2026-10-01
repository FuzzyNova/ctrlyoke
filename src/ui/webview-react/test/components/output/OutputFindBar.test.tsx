import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputFindBar } from "@components/output";
import type { OutputFindState } from "@hooks/useOutputFind";
import { useElementNarrow } from "@hooks/useElementNarrow";

vi.mock("@hooks/useElementNarrow", () => ({
  useElementNarrow: vi.fn(() => [vi.fn(), false] as const),
}));

function createState(
  overrides: Partial<OutputFindState> = {}
): OutputFindState {
  return {
    isOpen: false,
    query: "",
    caseSensitive: false,
    currentMatch: 0,
    matchCount: 0,
    mayMissMatches: false,
    ...overrides,
  };
}

describe("OutputFindBar", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(useElementNarrow).mockReturnValue([vi.fn(), false]);
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

  it("warns when find is searching capped output heads", () => {
    render(
      <OutputFindBar
        state={createState({ isOpen: true, mayMissMatches: true })}
        onQueryChange={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCaseSensitive={vi.fn()}
        onClose={vi.fn()}
        onKeyDown={vi.fn()}
      />
    );

    expect(
      screen.getByText("Matches in truncated outputs may be missed.")
    ).toHaveAttribute("role", "status");
  });

  it("keeps rendering long enough to play the exit animation", () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <OutputFindBar
        state={createState({
          isOpen: true,
          query: "alpha",
          matchCount: 2,
          currentMatch: 1,
        })}
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

  it("shows a compact zero-state counter", () => {
    render(
      <OutputFindBar
        state={createState({ isOpen: true })}
        onQueryChange={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCaseSensitive={vi.fn()}
        onClose={vi.fn()}
        onKeyDown={vi.fn()}
      />
    );

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
  });

  it("switches to a compact match counter when narrow", () => {
    vi.mocked(useElementNarrow).mockReturnValue([vi.fn(), true]);

    render(
      <OutputFindBar
        state={createState({
          isOpen: true,
          query: "alpha",
          matchCount: 12,
          currentMatch: 3,
        })}
        onQueryChange={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCaseSensitive={vi.fn()}
        onClose={vi.fn()}
        onKeyDown={vi.fn()}
      />
    );

    expect(screen.getByText("3/12")).toBeInTheDocument();
    expect(screen.queryByText("3 of 12")).not.toBeInTheDocument();
  });
});
