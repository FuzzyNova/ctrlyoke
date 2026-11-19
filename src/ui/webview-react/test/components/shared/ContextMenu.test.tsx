/**
 * Tests for ContextMenu's WAI-ARIA menu semantics: roles, initial focus,
 * arrow-key navigation over enabled items, and focus returning to the invoker.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ContextMenu,
  type ContextMenuEntry,
} from "@components/shared/ContextMenu";

function item(
  label: string,
  overrides: Partial<Extract<ContextMenuEntry, { label: string }>> = {}
): ContextMenuEntry {
  return {
    label,
    icon: "codicon-copy",
    disabled: false,
    onClick: vi.fn(),
    ...overrides,
  };
}

function renderMenu(
  items: ContextMenuEntry[],
  props: { label?: string; onClose?: () => void } = {}
) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <ContextMenu
      x={10}
      y={10}
      items={items}
      label={props.label}
      onClose={onClose}
    />
  );
  return { onClose };
}

describe("ContextMenu", () => {
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

  it("is non-selectable so a long press does not select item labels on iOS", () => {
    renderMenu([item("Copy")]);
    expect(screen.getByRole("menu")).toHaveClass("cy-no-select");
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

  describe("keepInvokerFocus (long press over an editor)", () => {
    function renderKeepingFocus(items: ContextMenuEntry[]) {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      editor.tabIndex = 0;
      document.body.appendChild(editor);
      editor.focus();
      const onClose = vi.fn();
      render(
        <ContextMenu
          x={10}
          y={10}
          items={items}
          keepInvokerFocus
          onClose={onClose}
        />
      );
      return { editor, onClose };
    }

    it("leaves focus in the editor when it opens", () => {
      const { editor } = renderKeepingFocus([item("Copy")]);
      expect(editor).toHaveFocus();
      editor.remove();
    });

    it("cancels the mousedown of a tap so the editor keeps focus", () => {
      const { editor } = renderKeepingFocus([item("Copy")]);
      const notCancelled = fireEvent.mouseDown(
        screen.getByRole("menuitem", { name: "Copy" })
      );
      expect(notCancelled).toBe(false);
      editor.remove();
    });

    it("closes when the viewport resizes", () => {
      const { editor, onClose } = renderKeepingFocus([item("Copy")]);
      fireEvent(window, new Event("resize"));
      expect(onClose).toHaveBeenCalled();
      editor.remove();
    });
  });

  it("does not close on resize when it took focus", () => {
    const { onClose } = renderMenu([item("Copy")]);
    fireEvent(window, new Event("resize"));
    expect(onClose).not.toHaveBeenCalled();
  });

  describe("submenus", () => {
    const labels = () =>
      screen.getAllByRole("menuitem").map((el) => el.textContent?.trim());

    function submenuMenu() {
      const nested = item("First nested");
      const entries: ContextMenuEntry[] = [
        item("Copy"),
        {
          label: "Recent",
          icon: "codicon-history",
          disabled: false,
          submenu: [nested, { type: "divider" }, item("Second nested")],
        },
      ];
      return { entries, nested };
    }

    it("drills into a submenu in place, with a Back row, and stays open", () => {
      const { entries } = submenuMenu();
      const { onClose } = renderMenu(entries);
      const recent = screen.getByRole("menuitem", { name: "Recent" });
      expect(recent).toHaveAttribute("aria-haspopup", "menu");

      fireEvent.click(recent);

      expect(onClose).not.toHaveBeenCalled();
      expect(labels()).toEqual(["Recent", "First nested", "Second nested"]);
      expect(
        screen.getByRole("menuitem", { name: "Back from Recent" })
      ).toHaveFocus();
    });

    it("runs a nested item and closes", () => {
      const { entries, nested } = submenuMenu();
      const { onClose } = renderMenu(entries);
      fireEvent.click(screen.getByRole("menuitem", { name: "Recent" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "First nested" }));

      expect(onClose).toHaveBeenCalled();
      expect(
        (nested as Extract<ContextMenuEntry, { onClick: unknown }>).onClick
      ).toHaveBeenCalled();
    });

    it("returns with the Back row or ArrowLeft, and opens with ArrowRight", () => {
      const { entries } = submenuMenu();
      renderMenu(entries);
      const recent = screen.getByRole("menuitem", { name: "Recent" });

      fireEvent.keyDown(recent, { key: "ArrowRight" });
      expect(labels()).toContain("First nested");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowLeft" });
      expect(labels()).toEqual(["Copy", "Recent"]);

      fireEvent.click(screen.getByRole("menuitem", { name: "Recent" }));
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Back from Recent" })
      );
      expect(labels()).toEqual(["Copy", "Recent"]);
    });

    it("does not open a disabled submenu", () => {
      renderMenu([
        {
          label: "Recent",
          icon: "codicon-history",
          disabled: true,
          disabledTitle: "Nothing yet",
          submenu: [item("Hidden")],
        },
      ]);
      const recent = screen.getByRole("menuitem", { name: "Recent" });
      expect(recent).toBeDisabled();
      fireEvent.click(recent);
      expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
    });
  });
});
