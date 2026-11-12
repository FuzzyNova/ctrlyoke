import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CollapsibleRegion } from "@components/shared/CollapsibleRegion";

describe("CollapsibleRegion", () => {
  afterEach(() => cleanup());

  it("keeps its content mounted but hidden and inert while collapsed", () => {
    const { rerender, container } = render(
      <CollapsibleRegion collapsed={false}>
        <div>
          <button type="button">inside</button>
        </div>
      </CollapsibleRegion>
    );
    const region = container.firstElementChild as HTMLElement;
    expect(region).toHaveClass("cy-collapsible");
    expect(region).toHaveAttribute("data-collapsed", "false");
    expect(region).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "inside" })).toBeInTheDocument();

    rerender(
      <CollapsibleRegion collapsed>
        <div>
          <button type="button">inside</button>
        </div>
      </CollapsibleRegion>
    );
    expect(region).toHaveAttribute("data-collapsed", "true");
    expect(region).toHaveAttribute("inert");
    expect(region).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: "inside" })).toBeNull();
    expect(screen.getByText("inside")).toBeInTheDocument();
  });
});
