import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hostedApi from "@utils/hostedApi";
import { useLanguageIntelligence } from "@hooks/useLanguageIntelligence";

describe("useLanguageIntelligence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns no extensions when the host has no matching session", async () => {
    const lookup = vi
      .spyOn(hostedApi, "languageIntelligenceSession")
      .mockResolvedValue({ session: null, reason: "no server" });
    const socket = vi.spyOn(window, "WebSocket");
    const { result } = renderHook(() => useLanguageIntelligence("src/app.ts"));

    await waitFor(() =>
      expect(lookup).toHaveBeenCalledWith("src/app.ts", expect.any(AbortSignal))
    );
    expect(result.current).toMatchObject({
      filePath: "src/app.ts",
      extensions: [],
      sessionId: null,
      capabilities: {},
    });
    expect(socket).not.toHaveBeenCalled();
  });

  it("surfaces a stopped-server lookup reason as an editor status hint", async () => {
    vi.spyOn(hostedApi, "languageIntelligenceSession").mockResolvedValue({
      session: null,
      reason: "stopped",
    });
    const { result } = renderHook(() => useLanguageIntelligence("src/app.ts"));

    await waitFor(() =>
      expect(result.current.statusHint).toContain("Language server is stopped")
    );
    expect(result.current.sessionId).toBeNull();
  });

  it("repeats session lookup after the host invalidates the socket", async () => {
    const lookup = vi
      .spyOn(hostedApi, "languageIntelligenceSession")
      .mockResolvedValueOnce({
        session: { id: "old", languageId: "typescript", capabilities: {} },
      })
      .mockResolvedValueOnce({
        session: {
          id: "new",
          languageId: "typescript",
          capabilities: { definitionProvider: true },
        },
      });
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        FakeWebSocket.instances.push(this);
      }
      send(): void {}
      close(): void {
        this.onclose?.({ code: 1000 });
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useLanguageIntelligence("src/app.ts"));
    await waitFor(() => expect(result.current.sessionId).toBe("old"));
    act(() => FakeWebSocket.instances[0]!.onclose?.({ code: 4410 }));
    await waitFor(() => expect(result.current.sessionId).toBe("new"));
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
