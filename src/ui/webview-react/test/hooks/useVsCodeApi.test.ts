/**
 * Tests for useVsCodeApi hook and getVsCodeApi function.
 *
 * The VS Code API is mocked in test/setup.ts via window.vscodeApi.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useVsCodeApi, getVsCodeApi } from "@hooks/useVsCodeApi";

beforeEach(() => {
  window.vscodeApi = window.acquireVsCodeApi?.();
  delete window.__flightpathFlushBootstrapLogs;
});

// ---------------------------------------------------------------------------
// useVsCodeApi
// ---------------------------------------------------------------------------

describe("useVsCodeApi", () => {
  it("returns the VS Code API object", () => {
    const { result } = renderHook(() => useVsCodeApi());
    expect(result.current).toBeDefined();
    expect(typeof result.current).toBe("object");
  });

  it("provides postMessage as a function", () => {
    const { result } = renderHook(() => useVsCodeApi());
    expect(typeof result.current.postMessage).toBe("function");
  });

  it("provides getState as a function", () => {
    const { result } = renderHook(() => useVsCodeApi());
    expect(typeof result.current.getState).toBe("function");
  });

  it("provides setState as a function", () => {
    const { result } = renderHook(() => useVsCodeApi());
    expect(typeof result.current.setState).toBe("function");
  });

  it("returns same instance on multiple calls", () => {
    const { result: result1 } = renderHook(() => useVsCodeApi());
    const { result: result2 } = renderHook(() => useVsCodeApi());

    expect(result1.current).toBe(result2.current);
  });

  it("returns the mock from window.vscodeApi", () => {
    const { result } = renderHook(() => useVsCodeApi());
    expect(result.current).toBe(window.vscodeApi);
  });

  it("refreshes when window.vscodeApi is replaced", () => {
    const replacementApi = {
      postMessage: () => undefined,
      getState: () => null,
      setState: () => undefined,
    };

    window.vscodeApi = replacementApi;

    const { result } = renderHook(() => useVsCodeApi());
    expect(result.current).toBe(replacementApi);
  });

  it("flushes buffered bootstrap logs when the API resolves", () => {
    const flushMock = vi.fn();
    window.__flightpathFlushBootstrapLogs = flushMock;

    renderHook(() => useVsCodeApi());

    expect(flushMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getVsCodeApi (non-hook utility)
// ---------------------------------------------------------------------------

describe("getVsCodeApi", () => {
  it("returns the VS Code API object", () => {
    const api = getVsCodeApi();
    expect(api).toBeDefined();
    expect(typeof api).toBe("object");
  });

  it("returns same instance as useVsCodeApi", () => {
    const directApi = getVsCodeApi();
    const { result } = renderHook(() => useVsCodeApi());
    expect(directApi).toBe(result.current);
  });

  it("has postMessage, getState, setState functions", () => {
    const api = getVsCodeApi();
    expect(typeof api.postMessage).toBe("function");
    expect(typeof api.getState).toBe("function");
    expect(typeof api.setState).toBe("function");
  });

  it("returns the latest window.vscodeApi when the global changes", () => {
    const replacementApi = {
      postMessage: () => undefined,
      getState: () => null,
      setState: () => undefined,
    };

    window.vscodeApi = replacementApi;

    expect(getVsCodeApi()).toBe(replacementApi);
  });
});
