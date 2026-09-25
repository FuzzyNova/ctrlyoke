import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";
import { vi } from "vitest";

// waitFor/findBy* give up after 1s by default, which is a performance
// assertion in disguise: under `npm test` (this pool beside six extension
// hosts) CodeMirror's typing timers were measured firing late enough that
// BranchNameEditor's re-query landed after 1s and failed a correct component.
// Like `testTimeout` in vitest.config.ts, this is a budget for catching a real
// hang, kept well under the 20s test timeout so a genuine failure still reports
// its own assertion rather than a generic test timeout.
configure({ asyncUtilTimeout: 5000 });

// ---------------------------------------------------------------------------
// ResizeObserver mock — jsdom does not implement ResizeObserver
// ---------------------------------------------------------------------------
vi.stubGlobal(
  "ResizeObserver",
  class implements ResizeObserver {
    observe(_target: Element, _options?: ResizeObserverOptions) {}
    unobserve(_target: Element) {}
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
