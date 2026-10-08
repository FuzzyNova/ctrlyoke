import type { Transport } from "@codemirror/lsp-client";
import { confirmWorkspaceRename } from "./workspaceEditConfirmation";
import {
  LSP_METHODS,
  LSP_SESSION_INVALIDATION_CLOSE,
} from "@root/types/DashboardConstants";

let workspaceEditHandler: ((uri: string, edits: unknown[]) => void) | undefined;
export function setWorkspaceEditHandler(
  handler: (uri: string, edits: unknown[]) => void
): void {
  workspaceEditHandler = handler;
}

export interface LspWebSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
  onerror: (() => void) | null;
  send(message: string): void;
  close(): void;
}

export type LspWebSocketFactory = (url: string) => LspWebSocket;

const OPEN = 1;

/** CodeMirror transport with bounded reconnect delay and stable subscribers. */
export class LanguageIntelligenceTransport implements Transport {
  private readonly handlers = new Set<(value: string) => void>();
  private socket: LspWebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;

  constructor(
    private readonly url: string,
    private readonly createSocket: LspWebSocketFactory,
    private readonly onConnect: () => void,
    private readonly onDisconnect: () => void,
    private readonly onSessionEnded: () => void = () => undefined
  ) {}

  start(): void {
    this.openSocket();
  }

  send(message: string): void {
    if (!this.socket || this.socket.readyState !== OPEN) {
      throw new Error("Language intelligence socket is disconnected.");
    }
    this.socket.send(message);
  }

  subscribe(handler: (value: string) => void): void {
    this.handlers.add(handler);
  }

  unsubscribe(handler: (value: string) => void): void {
    this.handlers.delete(handler);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.handlers.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private openSocket(): void {
    if (this.disposed) return;
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.disposed || this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.onConnect();
    };
    socket.onmessage = (event) => {
      if (this.disposed || this.socket !== socket) return;
      const message =
        typeof event.data === "string" ? event.data : String(event.data);
      if (this.handleProxyMessage(message)) return;
      for (const handler of [...this.handlers]) handler(message);
    };
    socket.onclose = (event) => {
      if (this.disposed || this.socket !== socket) return;
      this.socket = null;
      this.onDisconnect();
      if (event?.code === LSP_SESSION_INVALIDATION_CLOSE.CODE) {
        this.onSessionEnded();
        return;
      }
      this.scheduleReconnect();
    };
    socket.onerror = () => socket.close();
  }

  private handleProxyMessage(raw: string): boolean {
    let message: { id?: string | number; method?: string; params?: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return false;
    }
    const socket = this.socket;
    if (
      message.method === LSP_METHODS.CONFIRM_WORKSPACE_RENAME &&
      message.id !== undefined
    ) {
      const fileCount = (message.params as { fileCount?: unknown } | undefined)
        ?.fileCount;
      void confirmWorkspaceRename(
        typeof fileCount === "number" ? fileCount : 0
      ).then((confirmed) => {
        if (
          !this.disposed &&
          socket &&
          this.socket === socket &&
          socket.readyState === OPEN
        )
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: confirmed,
            })
          );
      });
      return true;
    }
    if (message.method === LSP_METHODS.APPLY_WORKSPACE_TEXT_EDITS) {
      const params = message.params as
        { uri?: unknown; edits?: unknown } | undefined;
      if (typeof params?.uri === "string" && Array.isArray(params.edits)) {
        workspaceEditHandler?.(params.uri, params.edits);
      }
      return true;
    }
    return false;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(250 * 2 ** this.reconnectAttempt, 10_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }
}
