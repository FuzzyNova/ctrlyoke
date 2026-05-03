import "@testing-library/jest-dom";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// ResizeObserver mock — jsdom does not implement ResizeObserver
// ---------------------------------------------------------------------------
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

// ---------------------------------------------------------------------------
// matchMedia mock — jsdom does not implement window.matchMedia
// ---------------------------------------------------------------------------
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ---------------------------------------------------------------------------
// VS Code API mock
//
// uiStore uses `persist` middleware backed by vscode.getState/setState, and
// getVsCodeApi() is called when the store first initialises.  window.vscodeApi
// must be present before any store module is imported — setupFiles run before
// test files, so this assignment happens at the right time.
// ---------------------------------------------------------------------------
const mockVsCodeApi = {
  postMessage: vi.fn(),
  getState: vi.fn(() => null),
  setState: vi.fn(),
};

vi.stubGlobal("acquireVsCodeApi", () => mockVsCodeApi);

// useVsCodeApi.ts reads window.vscodeApi at module initialisation time.
Object.defineProperty(window, "vscodeApi", {
  value: mockVsCodeApi,
  writable: true,
  configurable: true,
});
