import { describe, expect, it, vi } from "vitest";
import {
  LanguageIntelligenceTransport,
  type LspWebSocket,
} from "@utils/languageIntelligenceTransport";
import { getWorkspaceRenameConfirmation } from "@utils/workspaceEditConfirmation";

class FakeSocket implements LspWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  disconnect(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe("LanguageIntelligenceTransport", () => {
  it("sends and dispatches subscribed JSON-RPC messages over its socket", () => {
    const socket = new FakeSocket();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const transport = new LanguageIntelligenceTransport(
      "ws://localhost/ws/lsp?server=id&token=token",
      () => socket,
      onConnect,
      onDisconnect
    );
    const received = vi.fn();
    transport.subscribe(received);
    transport.start();
    socket.open();

    transport.send('{"jsonrpc":"2.0","method":"initialized"}');
    socket.receive(
      '{"jsonrpc":"2.0","method":"textDocument/publishDiagnostics"}'
    );

    expect(onConnect).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual(['{"jsonrpc":"2.0","method":"initialized"}']);
    expect(received).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
    transport.dispose();
  });

  it("reconnects after a dropped socket without losing subscribers", () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const received = vi.fn();
      const transport = new LanguageIntelligenceTransport(
        "ws://localhost/ws/lsp?server=id&token=token",
        () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        vi.fn(),
        vi.fn()
      );
      transport.subscribe(received);
      transport.start();
      sockets[0].open();
      sockets[0].disconnect();
      vi.advanceTimersByTime(250);
      sockets[1].open();
      sockets[1].receive("reconnected");

      expect(sockets).toHaveLength(2);
      expect(received).toHaveBeenCalledWith("reconnected");
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("relooks up ended sessions instead of reconnecting and drops stale confirmation replies", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const ended = vi.fn();
      const transport = new LanguageIntelligenceTransport(
        "ws://localhost",
        () => socket,
        vi.fn(),
        vi.fn(),
        ended
      );
      transport.start();
      socket.open();
      socket.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "ctrlyoke/confirmWorkspaceRename",
          params: { fileCount: 2 },
        })
      );
      const confirmation = getWorkspaceRenameConfirmation();
      expect(confirmation).not.toBeNull();
      socket.disconnect(4410);
      confirmation?.respond(true);
      await Promise.resolve();
      expect(ended).toHaveBeenCalledOnce();
      expect(socket.sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
