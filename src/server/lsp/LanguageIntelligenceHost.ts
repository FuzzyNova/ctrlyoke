import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { MessageConnection } from "vscode-jsonrpc";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";
import type { LanguageIntelligenceSessionLookupResponse } from "../../types/HostedWorkspaceViewerTypes";
import { LSP_METHODS } from "./LspProtocol";
import type {
  LanguageServerBackend,
  LanguageServerDescriptor,
} from "./LanguageServerBackend";
import { LANGUAGE_SERVER_RESOLUTION_REASONS } from "./LanguageServerBackend";
import { LspSessionProxy } from "./LspSessionProxy";
import type { WorkspacePathContext } from "./WorkspacePathContainment";
import { safeResolveWorkspacePath } from "./WorkspacePathContainment";

interface SharedDocument {
  readonly uri: string;
  readonly tabs: Map<LspSessionProxy, { text: string; version: number }>;
  syncedText?: string;
  syncedVersion?: number;
}

interface SharedServerSession {
  readonly id: string;
  readonly descriptor: LanguageServerDescriptor;
  readonly connection: MessageConnection;
  readonly documents: Map<string, SharedDocument>;
  readonly proxies: Set<LspSessionProxy>;
}

export type LanguageIntelligenceSessionLookup = LanguageIntelligenceSessionLookupResponse;

export interface LanguageIntelligenceHostOptions {
  readonly backend: LanguageServerBackend;
  readonly workspaceRoot: string;
  readonly namedWorkspaceRoots: readonly ResolverWorkspaceFolder[];
  readonly isWorkspaceTrusted: () => boolean;
}

/** Owns one initialized server per server id and workspace root. */
export class LanguageIntelligenceHost {
  private readonly roots: WorkspacePathContext;
  private readonly sessions = new Map<string, Promise<SharedServerSession>>();
  private readonly sessionsById = new Map<string, Promise<SharedServerSession>>();
  private disposed = false;

  constructor(private readonly options: LanguageIntelligenceHostOptions) {
    this.roots = {
      workspaceRoot: options.workspaceRoot,
      namedRoots: options.namedWorkspaceRoots,
    };
  }

  async lookupSession(viewerPath: string): Promise<LanguageIntelligenceSessionLookup> {
    if (!this.options.isWorkspaceTrusted()) {
      return { session: null, reason: LANGUAGE_SERVER_RESOLUTION_REASONS.UNTRUSTED };
    }
    if (!safeResolveWorkspacePath(viewerPath, this.roots)) {
      return { session: null, reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
    }
    const resolution = await this.options.backend.resolveForPath(
      viewerPath,
      this.roots
    );
    if (!this.options.isWorkspaceTrusted()) {
      return { session: null, reason: LANGUAGE_SERVER_RESOLUTION_REASONS.UNTRUSTED };
    }
    if (!("descriptor" in resolution)) {
      return { session: null, reason: resolution.reason };
    }
    const session = await this.getOrCreateSession(resolution.descriptor);
    return {
      session: {
        id: session.id,
        languageId: resolution.descriptor.languageId,
      },
    };
  }

  async createProxy(
    serverId: string,
    send: (message: unknown) => void,
    canOpenPath: (viewerPath: string) => Promise<boolean>
  ): Promise<LspSessionProxy | undefined> {
    if (this.disposed || !this.options.isWorkspaceTrusted()) return undefined;
    const pending = this.sessionsById.get(serverId);
    if (!pending) return undefined;
    const session = await pending;
    if (!this.options.isWorkspaceTrusted()) return undefined;
    const proxy = new LspSessionProxy({
      descriptor: session.descriptor,
      connection: session.connection,
      roots: this.roots,
      send,
      canOpenPath,
      documents: session.documents,
      onDispose: () => session.proxies.delete(proxy),
    });
    session.proxies.add(proxy);
    return proxy;
  }

  async notifyWorkspaceFileChanged(viewerPath: string): Promise<void> {
    const absolutePath = safeResolveWorkspacePath(viewerPath, this.roots);
    if (!absolutePath) return;
    const uri = pathToFileURL(absolutePath).toString();
    for (const pending of this.sessions.values()) {
      const session = await pending;
      void session.connection.sendNotification(
        LSP_METHODS.DID_CHANGE_WATCHED_FILES,
        { changes: [{ uri, type: 2 }] }
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.sessions.values()) {
      void pending.then((session) => {
        for (const proxy of [...session.proxies]) proxy.dispose();
        session.connection.dispose();
      });
    }
    this.sessions.clear();
    this.sessionsById.clear();
  }

  private getOrCreateSession(
    descriptor: LanguageServerDescriptor
  ): Promise<SharedServerSession> {
    const root = path.resolve(descriptor.rootPath);
    const key = `${descriptor.id}\n${root}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created = Promise.resolve(this.options.backend.getConnection(descriptor)).then(
      (connection) => {
        const session: SharedServerSession = {
          id: randomUUID(),
          descriptor: { ...descriptor, rootPath: root },
          connection,
          documents: new Map(),
          proxies: new Set(),
        };
        connection.onNotification((method, rawParams) => {
          if (method === LSP_METHODS.PUBLISH_DIAGNOSTICS) {
            const params = rawParams as
              | ({ uri?: unknown } & Record<string, unknown>)
              | undefined;
            if (typeof params?.uri !== "string") return;
            const document = session.documents.get(params.uri);
            if (!document) return;
            for (const [proxy, buffer] of document.tabs) {
              if (buffer.text === document.syncedText) {
                proxy.deliverServerMessage({
                  jsonrpc: "2.0",
                  method,
                  params,
                });
              }
            }
            return;
          }
          for (const proxy of session.proxies) {
            proxy.deliverServerMessage({
              jsonrpc: "2.0",
              method,
              ...(rawParams === undefined ? {} : { params: rawParams }),
            });
          }
        });
        connection.onRequest((method, params) => {
          const proxy = session.proxies.values().next().value;
          return proxy?.forwardServerRequest(method, params);
        });
        connection.listen();
        return session;
      }
    );
    this.sessions.set(key, created);
    void created.then((session) => {
      this.sessionsById.set(session.id, created);
    });
    return created;
  }
}
