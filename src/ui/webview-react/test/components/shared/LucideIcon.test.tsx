import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QrCode } from "lucide-react";
import { LucideIcon } from "@components/shared/LucideIcon";

describe("LucideIcon", () => {
  it("renders a 16px codicon-sized box by default", () => {
    const { container } = render(<LucideIcon icon={QrCode} />);

    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "16");
    expect(svg).toHaveAttribute("height", "16");
    expect(svg).toHaveClass("cy-lucide-icon");
  });

  it("maps named sizes to the codicon size variants and accepts pixels", () => {
    const { container } = render(
      <>
        <LucideIcon icon={QrCode} size="lg" />
        <LucideIcon icon={QrCode} size="xl" />
        <LucideIcon icon={QrCode} size={12} />
      </>
    );

    const sizes = Array.from(container.querySelectorAll("svg")).map((svg) =>
      svg.getAttribute("width")
    );
    expect(sizes).toEqual(["20", "24", "12"]);
  });

  it("passes through className alongside its own class", () => {
    const { container } = render(
      <LucideIcon icon={QrCode} className="text-foreground" />
    );

    expect(container.querySelector("svg")).toHaveClass(
      "cy-lucide-icon",
      "text-foreground"
    );
  });

  it('hides a decorative icon with aria-hidden="true"', () => {
    const { container } = render(<LucideIcon icon={QrCode} />);

    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("role");
  });

  it("exposes a meaningful icon as a named img instead of hiding it", () => {
    // Lucide skips its own aria-hidden once any aria-* prop is passed, and
    // aria-hidden alongside a label would remove the label from the
    // accessibility tree. The label must win.
    render(<LucideIcon icon={QrCode} aria-label="the QR code button" />);

    const svg = screen.getByRole("img", { name: "the QR code button" });
    expect(svg).not.toHaveAttribute("aria-hidden");
  });
});
