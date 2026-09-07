import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "@components/shared/Icon";

describe("Icon", () => {
  it("normalizes prefixed and unprefixed codicon names", () => {
    const { container } = render(
      <>
        <Icon name="chevron-down" />
        <Icon name="codicon-chevron-up" />
      </>
    );

    expect(container.querySelectorAll("i")[0]).toHaveClass(
      "codicon",
      "codicon-chevron-down"
    );
    expect(container.querySelectorAll("i")[1]).toHaveClass(
      "codicon",
      "codicon-chevron-up"
    );
  });

  it("passes through className and style", () => {
    const { container } = render(
      <Icon
        name="settings"
        className="codicon-lg text-foreground"
        style={{ fontSize: 20 }}
      />
    );

    const icon = container.querySelector("i");
    expect(icon).not.toBeNull();
    expect(icon).toHaveClass("codicon-lg", "text-foreground");
    expect(icon).toHaveStyle({ fontSize: "20px" });
  });

  it('hides a decorative icon with aria-hidden="true"', () => {
    const { container } = render(<Icon name="warning" />);

    const icon = container.querySelector("i");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).not.toHaveAttribute("role");
  });

  it("exposes a meaningful icon as a named img instead of hiding it", () => {
    // aria-hidden="true" removes the element from the accessibility tree, so an
    // aria-label alongside it would reach nobody. The label must win.
    render(<Icon name="terminal" aria-label="Terminal session is running" />);

    const icon = screen.getByRole("img", {
      name: "Terminal session is running",
    });
    expect(icon).not.toHaveAttribute("aria-hidden");
  });
});
