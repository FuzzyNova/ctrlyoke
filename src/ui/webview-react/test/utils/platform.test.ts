import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPlatform, formatShortcut, isIosDevice } from "@utils/platform";
import { UI_PLATFORMS } from "@root/types/DashboardConstants";

function mockNavigator(platform: string, userAgent: string) {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
}

describe("detectPlatform", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects Windows from navigator.platform", () => {
    mockNavigator("Win32", "Mozilla/5.0 (Windows NT 10.0)");
    expect(detectPlatform()).toBe(UI_PLATFORMS.WINDOWS);
  });

  it("detects Windows from userAgent when platform is unhelpful", () => {
    mockNavigator("", "Mozilla/5.0 (Windows NT 10.0)");
    expect(detectPlatform()).toBe(UI_PLATFORMS.WINDOWS);
  });

  it("detects macOS", () => {
    mockNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)");
    expect(detectPlatform()).toBe(UI_PLATFORMS.MAC);
  });

  it("falls back to Linux for everything else", () => {
    mockNavigator("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
    expect(detectPlatform()).toBe(UI_PLATFORMS.LINUX);
  });
});

describe("formatShortcut", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps Ctrl on Windows", () => {
    mockNavigator("Win32", "Mozilla/5.0 (Windows NT 10.0)");
    expect(formatShortcut("Ctrl", "Shift", "F")).toBe("Ctrl+Shift+F");
  });

  it("keeps Ctrl on Linux", () => {
    mockNavigator("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
    expect(formatShortcut("Ctrl", "Z")).toBe("Ctrl+Z");
  });

  it("swaps Ctrl for Cmd on macOS", () => {
    mockNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)");
    expect(formatShortcut("Ctrl", "Shift", "F")).toBe("Cmd+Shift+F");
  });

  it("leaves non-Ctrl parts untouched on macOS", () => {
    mockNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)");
    expect(formatShortcut("Shift", "Ctrl", "Enter")).toBe("Shift+Cmd+Enter");
  });
});

// jsdom doesn't implement navigator.maxTouchPoints, so define it per test.
function mockMaxTouchPoints(value: number) {
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value,
    configurable: true,
  });
}

describe("isIosDevice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window.navigator, "maxTouchPoints");
  });

  it("detects iPhone from the user agent", () => {
    mockNavigator(
      "iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)"
    );
    expect(isIosDevice()).toBe(true);
  });

  it("detects iPadOS Safari, which reports desktop macOS but has touch", () => {
    mockNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)");
    mockMaxTouchPoints(5);
    expect(isIosDevice()).toBe(true);
  });

  it("does not flag a desktop Mac or Android", () => {
    mockNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)");
    mockMaxTouchPoints(0);
    expect(isIosDevice()).toBe(false);
    mockNavigator(
      "Linux armv8l",
      "Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/141.0"
    );
    expect(isIosDevice()).toBe(false);
  });
});
