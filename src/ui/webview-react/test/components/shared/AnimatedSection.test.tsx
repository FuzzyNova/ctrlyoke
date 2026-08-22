import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { AnimatedSection } from "@components/shared/AnimatedSection";

const ANIMATION_DURATION_MS = 300;

describe("AnimatedSection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders children while visible", () => {
    render(
      <AnimatedSection visible>
        <p>content</p>
      </AnimatedSection>
    );

    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("keeps children mounted while closing, then unmounts them", () => {
    const { rerender } = render(
      <AnimatedSection visible>
        <p>content</p>
      </AnimatedSection>
    );

    rerender(
      <AnimatedSection visible={false}>
        <p>content</p>
      </AnimatedSection>
    );
    expect(screen.getByText("content")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(ANIMATION_DURATION_MS);
    });
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("stays mounted when reopened before the close animation finishes", () => {
    const { rerender } = render(
      <AnimatedSection visible>
        <p>content</p>
      </AnimatedSection>
    );

    // Start closing, then reopen partway through the animation — the pattern a
    // user produces by toggling a mode switch twice in quick succession.
    rerender(
      <AnimatedSection visible={false}>
        <p>content</p>
      </AnimatedSection>
    );
    act(() => {
      vi.advanceTimersByTime(ANIMATION_DURATION_MS / 3);
    });
    rerender(
      <AnimatedSection visible>
        <p>content</p>
      </AnimatedSection>
    );

    // The close timer scheduled before the reopen must not unmount the section
    // that is now visible again.
    act(() => {
      vi.advanceTimersByTime(ANIMATION_DURATION_MS * 2);
    });
    expect(screen.getByText("content")).toBeInTheDocument();
  });
});
