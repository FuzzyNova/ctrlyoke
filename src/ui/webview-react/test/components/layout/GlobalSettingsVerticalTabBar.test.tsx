import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GlobalSettingsVerticalTabBar } from "@components/layout/GlobalSettingsVerticalTabBar";
import { ALL_TABS } from "@components/settings/settingsTabs";

const TABS = [...ALL_TABS];

interface ScrollGeometry {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** jsdom does no layout, so give the rail's scroller explicit geometry. */
function setScrollGeometry(element: HTMLElement, geometry: ScrollGeometry) {
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: geometry.scrollTop,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: geometry.clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: geometry.scrollHeight,
  });
  fireEvent.scroll(element);
}

function renderRail(activeTab = ALL_TABS[0].id) {
  return render(
    <GlobalSettingsVerticalTabBar
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={vi.fn()}
      iconOnly
    />
  );
}

describe("GlobalSettingsVerticalTabBar", () => {
  it("shows no scroll chevrons when every tab fits", () => {
    renderRail();
    setScrollGeometry(screen.getByTestId("settings-tab-rail-scroller"), {
      scrollTop: 0,
      clientHeight: 600,
      scrollHeight: 600,
    });

    expect(screen.queryByLabelText("Scroll tabs up")).toBeNull();
    expect(screen.queryByLabelText("Scroll tabs down")).toBeNull();
  });

  it("shows only the chevron for each edge with hidden tabs", () => {
    renderRail();
    const scroller = screen.getByTestId("settings-tab-rail-scroller");

    setScrollGeometry(scroller, {
      scrollTop: 0,
      clientHeight: 300,
      scrollHeight: 600,
    });
    expect(screen.queryByLabelText("Scroll tabs up")).toBeNull();
    expect(screen.getByLabelText("Scroll tabs down")).toBeTruthy();

    setScrollGeometry(scroller, {
      scrollTop: 150,
      clientHeight: 300,
      scrollHeight: 600,
    });
    expect(screen.getByLabelText("Scroll tabs up")).toBeTruthy();
    expect(screen.getByLabelText("Scroll tabs down")).toBeTruthy();

    setScrollGeometry(scroller, {
      scrollTop: 300,
      clientHeight: 300,
      scrollHeight: 600,
    });
    expect(screen.getByLabelText("Scroll tabs up")).toBeTruthy();
    expect(screen.queryByLabelText("Scroll tabs down")).toBeNull();
  });

  it("scrolls the rail by most of a page when a chevron is clicked", () => {
    renderRail();
    const scroller = screen.getByTestId("settings-tab-rail-scroller");
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy;
    setScrollGeometry(scroller, {
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 800,
    });

    fireEvent.click(screen.getByLabelText("Scroll tabs down"));

    expect(scrollBy).toHaveBeenCalledWith({ top: 300, behavior: "smooth" });
  });

  it("scrolls the active tab into view when it changes", () => {
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender } = renderRail(ALL_TABS[0].id);
      scrollIntoView.mockClear();
      const lastTab = ALL_TABS[ALL_TABS.length - 1];

      rerender(
        <GlobalSettingsVerticalTabBar
          tabs={TABS}
          activeTab={lastTab.id}
          onTabChange={vi.fn()}
          iconOnly
        />
      );

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(
        screen.getByRole("button", { name: lastTab.label })
      );
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
