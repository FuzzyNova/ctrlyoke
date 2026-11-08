/**
 * Tests for DropdownPortal's container: it renders into document.body, so it
 * must carry the non-selectable chrome class itself rather than inherit it.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DropdownPortal } from "@components/shared/DropdownPortal";

describe("DropdownPortal", () => {
  it("is non-selectable and keeps caller classes", () => {
    render(
      <DropdownPortal
        isOpen
        popupPos={{ top: 0, left: 0, maxHeight: 200 }}
        role="listbox"
        className="extra-class"
      >
        <div role="option" aria-selected={false}>
          Option
        </div>
      </DropdownPortal>
    );
    const popup = screen.getByRole("listbox");
    expect(popup).toHaveClass("cy-no-select");
    expect(popup).toHaveClass("extra-class");
    expect(popup.parentElement).toBe(document.body);
  });

  it("renders nothing when closed", () => {
    render(
      <DropdownPortal
        isOpen={false}
        popupPos={{ top: 0, left: 0, maxHeight: 200 }}
        role="listbox"
      >
        <div />
      </DropdownPortal>
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
