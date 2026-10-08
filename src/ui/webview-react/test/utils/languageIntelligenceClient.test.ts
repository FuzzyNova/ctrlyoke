import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLanguageIntelligenceClient } from "@utils/languageIntelligenceClient";
import type { LspWebSocket } from "@utils/languageIntelligenceTransport";

class FakeSocket implements LspWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("language intelligence client lifetime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels deferred disposal when a file switch reacquires the session", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const createSocket = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const first = acquireLanguageIntelligenceClient(
      "grace-session",
      "typescript",
      "a.ts",
      "ws://localhost",
      createSocket
    );
    first.release();
    vi.advanceTimersByTime(250);
    const second = acquireLanguageIntelligenceClient(
      "grace-session",
      "typescript",
      "b.ts",
      "ws://localhost",
      createSocket
    );
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(1);
    second.release();
    vi.advanceTimersByTime(500);
  });
});
