import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type {
  LanguageServerBackend,
  LanguageServerDescriptor,
  LanguageServerResolution,
} from "../../server/lsp/LanguageServerBackend";
import type { WorkspacePathContext } from "../../server/lsp/WorkspacePathContainment";

export class InMemoryLanguageServerBackend implements LanguageServerBackend {
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly events: Array<{
    isNotification: boolean;
    method: string;
    params: unknown;
  }> = [];
  readonly serverConnections: MessageConnection[] = [];
  requestHandler: (method: string, params: unknown) => unknown = () => null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly languageId = "typescript"
  ) {}

  resolveForPath(_viewerPath: string, _roots: WorkspacePathContext): LanguageServerResolution {
    return {
      descriptor: {
        id: "fake-lsp",
        languageId: this.languageId,
        rootPath: this.workspaceRoot,
        capabilities: { hoverProvider: true, definitionProvider: true },
        serverInfo: { name: "fake-lsp" },
      },
    };
  }

  getConnection(_descriptor: LanguageServerDescriptor): MessageConnection {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const client = createMessageConnection(
      new StreamMessageReader(serverToClient),
      new StreamMessageWriter(clientToServer)
    );
    const server = createMessageConnection(
      new StreamMessageReader(clientToServer),
      new StreamMessageWriter(serverToClient)
    );
    server.onNotification((method, params) => {
      this.notifications.push({ method, params });
      this.events.push({ isNotification: true, method, params });
    });
    server.onRequest((method, params) => {
      this.requests.push({ method, params });
      this.events.push({ isNotification: false, method, params });
      return this.requestHandler(
        method,
        Array.isArray(params) ? params[0] : params
      );
    });
    server.listen();
    this.serverConnections.push(server);
    return client;
  }
}
