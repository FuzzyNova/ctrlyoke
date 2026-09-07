import { render } from "@testing-library/react";
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

  it('always renders aria-hidden="true"', () => {
    const { container } = render(<Icon name="warning" />);

    expect(container.querySelector("i")).toHaveAttribute("aria-hidden", "true");
  });
});
