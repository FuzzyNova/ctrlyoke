/**
 * Tests for StepContextMenu's WAI-ARIA menu semantics: roles, initial focus,
 * arrow-key navigation over enabled items, and focus returning to the invoker.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  StepContextMenu,
  type StepContextMenuEntry,
} from "@components/shared/StepContextMenu";

function item(
  label: string,
  overrides: Partial<Extract<StepContextMenuEntry, { label: string }>> = {}
): StepContextMenuEntry {
  return {
    label,
    icon: "codicon-copy",
    disabled: false,
    onClick: vi.fn(),
    ...overrides,
  };
}

function renderMenu(
  items: StepContextMenuEntry[],
  props: { label?: string; onClose?: () => void } = {}
) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <StepContextMenu
      x={10}
      y={10}
      items={items}
      label={props.label}
      onClose={onClose}
    />
  );
  return { onClose };
}

describe("StepContextMenu", () => {
  it("exposes a labelled menu of menuitems", () => {
    renderMenu([item("Copy"), { type: "divider" }, item("Delete")], {
      label: "Step actions",
    });

    const menu = screen.getByRole("menu", { name: "Step actions" });
    expect(menu).toBeInTheDocument();
    expect(
      screen.getAllByRole("menuitem").map((el) => el.textContent?.trim())
    ).toEqual(["Copy", "Delete"]);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("falls back to a generic accessible name", () => {
    renderMenu([item("Copy")]);
    expect(
      screen.getByRole("menu", { name: "Context menu" })
    ).toBeInTheDocument();
  });

  it("focuses the first enabled item on open", () => {
    renderMenu([item("Cut", { disabled: true }), item("Copy")]);
    expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveFocus();
  });

  it("moves through enabled items with arrows, Home and End, wrapping", () => {
    renderMenu([
      item("One"),
      item("Two", { disabled: true }),
      item("Three"),
      item("Four"),
    ]);
    const focused = () => (document.activeElement as HTMLElement).textContent;

    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(focused()).toBe("Three");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(focused()).toBe("Four");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(focused()).toBe("One");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(focused()).toBe("Four");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(focused()).toBe("One");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(focused()).toBe("Four");
  });

  it("returns focus to the invoker and closes on Escape", () => {
    const invoker = document.createElement("button");
    document.body.appendChild(invoker);
    invoker.focus();
    const { onClose } = renderMenu([item("Copy")]);
    expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveFocus();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(invoker).toHaveFocus();
    invoker.remove();
  });

  it("returns focus to the invoker before running the chosen item", () => {
    const invoker = document.createElement("button");
    document.body.appendChild(invoker);
    invoker.focus();
    let focusedDuringAction: Element | null = null;
    const { onClose } = renderMenu([
      item("Cut", {
        onClick: () => {
          focusedDuringAction = document.activeElement;
        },
      }),
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Cut" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(focusedDuringAction).toBe(invoker);
    invoker.remove();
  });
});
