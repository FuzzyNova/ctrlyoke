import { renderHook, waitFor } from "@testing-library/react";
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
});
