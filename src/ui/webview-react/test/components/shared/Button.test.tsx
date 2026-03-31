import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@components/shared/Button";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(
      screen.getByRole("button", { name: "Click me" })
    ).toBeInTheDocument();
  });

  it("calls onClick when clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not call onClick when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Click me
      </Button>
    );
    await user.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies primary variant classes by default", () => {
    render(<Button>Btn</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-btn-bg");
  });

  it("applies secondary variant classes", () => {
    render(<Button variant="secondary">Btn</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-btn-secondary-bg");
  });

  it("applies danger variant classes", () => {
    render(<Button variant="danger">Btn</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-bash-status-error");
  });

  it("applies sm size classes", () => {
    render(<Button size="sm">Btn</Button>);
    expect(screen.getByRole("button").className).toContain("text-xs");
  });

  it("applies lg size classes", () => {
    render(<Button size="lg">Btn</Button>);
    expect(screen.getByRole("button").className).toContain("text-base");
  });

  it("merges additional className", () => {
    render(<Button className="extra-class">Btn</Button>);
    expect(screen.getByRole("button").className).toContain("extra-class");
  });

  it("passes through native button attributes", () => {
    render(
      <Button type="submit" aria-label="submit form">
        Submit
      </Button>
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("type", "submit");
    expect(btn).toHaveAttribute("aria-label", "submit form");
  });
});
