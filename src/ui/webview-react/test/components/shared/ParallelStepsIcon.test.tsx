import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ParallelStepsIcon } from "@components/shared/ParallelStepsIcon";

describe("ParallelStepsIcon", () => {
  it("renders Lucide's split flipped vertically so it points at the steps below", () => {
    const { container } = render(<ParallelStepsIcon />);

    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("lucide-split", "cy-lucide-icon", "-scale-y-100");
    expect(svg).toHaveAttribute("width", "16");
  });

  it("forwards size and className", () => {
    const { container } = render(
      <ParallelStepsIcon size={10} className="text-description-fg" />
    );

    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "10");
    expect(svg).toHaveClass("-scale-y-100", "text-description-fg");
  });
});
