import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPlatform, formatShortcut } from "@utils/platform";
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
