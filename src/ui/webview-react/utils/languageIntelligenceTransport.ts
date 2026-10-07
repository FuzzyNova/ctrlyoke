import type { Transport } from "@codemirror/lsp-client";

export interface LspWebSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
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
    private readonly onDisconnect: () => void
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
      const message = typeof event.data === "string" ? event.data : String(event.data);
      for (const handler of [...this.handlers]) handler(message);
    };
    socket.onclose = () => {
      if (this.disposed || this.socket !== socket) return;
      this.socket = null;
      this.onDisconnect();
      this.scheduleReconnect();
    };
    socket.onerror = () => socket.close();
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
