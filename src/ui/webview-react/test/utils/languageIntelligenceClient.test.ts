import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireLanguageIntelligenceClient,
  withLanguageIntelligenceDocument,
} from "@utils/languageIntelligenceClient";
import type { LspWebSocket } from "@utils/languageIntelligenceTransport";

class FakeSocket implements LspWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(_message: string): void {}
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

/** A socket whose server answers `initialize`, so the client can initialize. */
class InitializingSocket extends FakeSocket {
  readonly sent: { method?: string; params?: unknown }[] = [];
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  override send(message: string): void {
    const parsed = JSON.parse(message) as { id?: number; method?: string };
    this.sent.push(parsed);
    if (parsed.method === "initialize") {
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { capabilities: {} },
          }),
        })
      );
    }
  }
}

describe("withLanguageIntelligenceDocument", () => {
  it("waits for the session to connect before opening the file and requesting", async () => {
    const socket = new InitializingSocket();
    const request = vi.fn(async () => "references");
    const pending = withLanguageIntelligenceDocument(
      "connect-session",
      "typescript",
      "src/a.ts",
      "ws://localhost",
      () => socket,
      async () => "export const a = 1;",
      request
    );

    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();

    socket.open();
    await expect(pending).resolves.toBe("references");
    expect(socket.sent.map((message) => message.method)).toEqual(
      expect.arrayContaining(["initialize", "textDocument/didOpen"])
    );
  });
});
