import type { ReactElement } from "react";
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

function renderRail(activeTab: string = ALL_TABS[0].id) {
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

  function setRect(element: HTMLElement, top: number, bottom: number) {
    element.getBoundingClientRect = () =>
      ({ top, bottom, left: 0, right: 40, height: bottom - top }) as DOMRect;
  }

  function rerenderWithActiveTab(
    rerender: (ui: ReactElement) => void,
    activeTab: string
  ) {
    rerender(
      <GlobalSettingsVerticalTabBar
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={vi.fn()}
        iconOnly
      />
    );
  }

  it("scrolls only the rail to reveal a newly active tab below it", () => {
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender } = renderRail(ALL_TABS[0].id);
      const scroller = screen.getByTestId("settings-tab-rail-scroller");
      setScrollGeometry(scroller, {
        scrollTop: 0,
        clientHeight: 300,
        scrollHeight: 600,
      });
      setRect(scroller, 100, 400);
      const lastTab = ALL_TABS[ALL_TABS.length - 1];
      setRect(screen.getByRole("button", { name: lastTab.label }), 450, 486);

      rerenderWithActiveTab(rerender, lastTab.id);

      expect(scroller.scrollTop).toBe(86);
      // scrollIntoView would also scroll the drawer's overflow-hidden
      // ancestors while the drawer is still parked off-screen on mount.
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("scrolls the rail up to reveal a newly active tab above it", () => {
    const lastTab = ALL_TABS[ALL_TABS.length - 1];
    const { rerender } = renderRail(lastTab.id);
    const scroller = screen.getByTestId("settings-tab-rail-scroller");
    setScrollGeometry(scroller, {
      scrollTop: 200,
      clientHeight: 300,
      scrollHeight: 600,
    });
    setRect(scroller, 100, 400);
    setRect(screen.getByRole("button", { name: ALL_TABS[0].label }), 40, 76);

    rerenderWithActiveTab(rerender, ALL_TABS[0].id);

    expect(scroller.scrollTop).toBe(140);
  });

  it("leaves the rail alone when the active tab is already visible", () => {
    const { rerender } = renderRail(ALL_TABS[0].id);
    const scroller = screen.getByTestId("settings-tab-rail-scroller");
    setScrollGeometry(scroller, {
      scrollTop: 50,
      clientHeight: 300,
      scrollHeight: 600,
    });
    setRect(scroller, 100, 400);
    setRect(screen.getByRole("button", { name: ALL_TABS[1].label }), 150, 186);

    rerenderWithActiveTab(rerender, ALL_TABS[1].id);

    expect(scroller.scrollTop).toBe(50);
  });
});
