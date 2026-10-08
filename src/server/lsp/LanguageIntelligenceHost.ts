import * as path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { MessageConnection } from "vscode-jsonrpc";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";
import type { LanguageIntelligenceSessionLookupResponse } from "../../types/HostedWorkspaceViewerTypes";
import {
  LSP_METHODS,
  canonicalServerFileUri,
  toServerFileUri,
} from "./LspProtocol";
import type {
  LanguageServerBackend,
  LanguageServerDescriptor,
} from "./LanguageServerBackend";
import { LANGUAGE_SERVER_RESOLUTION_REASONS } from "./LanguageServerBackend";
import { LspSessionProxy } from "./LspSessionProxy";
import type { SharedDocument } from "./LspSharedDocument";
import type { WorkspacePathContext } from "./WorkspacePathContainment";
import { safeResolveWorkspacePath } from "./WorkspacePathContainment";
import type { LanguageServerStatusChange } from "./ManagedLanguageServerBackend";
import { LANGUAGE_SERVER_STATUSES, type LanguageServerRequestOrigin } from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";
import { secretRedactionService } from "../../utils/SecretRedactionService";

interface SharedServerSession {
  readonly id: string;
  descriptor: LanguageServerDescriptor;
  readonly connection: MessageConnection;
  readonly documents: Map<string, SharedDocument>;
  readonly proxies: Set<LspSessionProxy>;
}

const MAX_WARMUP_DOCUMENT_BYTES = 2 * 1024 * 1024;
const BINARY_CHECK_BYTES = 8_192;

export type LanguageIntelligenceSessionLookup =
  LanguageIntelligenceSessionLookupResponse;

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
  private readonly sessionsById = new Map<
    string,
    Promise<SharedServerSession>
  >();
  private disposed = false;
  private readonly warmupDocuments = new Map<string, Set<string>>();
  private readonly statusEvents = new EventEmitter();
  private readonly backendStatusSubscription?: { dispose(): void };

  constructor(private readonly options: LanguageIntelligenceHostOptions) {
    this.roots = {
      workspaceRoot: options.workspaceRoot,
      namedRoots: options.namedWorkspaceRoots,
    };
    const statusSource = options.backend as LanguageServerBackend & {
      onStatusChanged?: (
        listener: (event: LanguageServerStatusChange) => void
      ) => { dispose(): void };
    };
    this.backendStatusSubscription = statusSource.onStatusChanged?.((event) => {
      this.statusEvents.emit("change", event);
      if (
        event.status === LANGUAGE_SERVER_STATUSES.CRASHED ||
        event.status === LANGUAGE_SERVER_STATUSES.STOPPED
      ) {
        this.invalidateSession(event.id, event.rootPath);
      }
    });
  }

  onStatusChanged(listener: (event: LanguageServerStatusChange) => void): {
    dispose(): void;
  } {
    this.statusEvents.on("change", listener);
    return { dispose: () => this.statusEvents.off("change", listener) };
  }

  async startLanguages(languageIds: readonly string[]): Promise<void> {
    await this.options.backend.startLanguages?.(languageIds);
  }

  /** Resolve a file while applying the caller's request-origin policy. */
  async resolveForPath(
    viewerPath: string,
    origin: LanguageServerRequestOrigin
  ): Promise<LanguageServerDescriptor | undefined> {
    if (this.disposed || !this.options.isWorkspaceTrusted()) return undefined;
    const resolution = await this.options.backend.resolveForPath(
      viewerPath,
      this.roots,
      origin
    );
    return "descriptor" in resolution ? resolution.descriptor : undefined;
  }

  async requestForPath(
    viewerPath: string,
    method: string,
    params: unknown,
    origin: LanguageServerRequestOrigin
  ): Promise<
    { descriptor: LanguageServerDescriptor; result: unknown } | undefined
  > {
    if (this.disposed || !this.options.isWorkspaceTrusted()) return undefined;
    const resolution = await this.options.backend.resolveForPath(
      viewerPath,
      this.roots,
      origin
    );
    if (!("descriptor" in resolution)) return undefined;
    const session = await this.getOrCreateSession(resolution.descriptor, origin);
    if (!this.options.isWorkspaceTrusted()) return undefined;
    return {
      descriptor: session.descriptor,
      result: await session.connection.sendRequest(method, params),
    };
  }

  async openWarmupDocument(
    viewerPath: string,
    languageId: string,
    origin: LanguageServerRequestOrigin
  ): Promise<void> {
    if (this.disposed || !this.options.isWorkspaceTrusted()) return;
    const absolutePath = safeResolveWorkspacePath(viewerPath, this.roots);
    if (!absolutePath) return;
    const resolution = await this.options.backend.resolveForPath(
      viewerPath,
      this.roots,
      origin
    );
    if (!("descriptor" in resolution)) return;
    const session = await this.getOrCreateSession(resolution.descriptor, origin);
    const uri = toServerFileUri(absolutePath);
    const opened = this.warmupDocuments.get(session.id) ?? new Set<string>();
    if (opened.has(uri)) return;
    opened.add(uri);
    this.warmupDocuments.set(session.id, opened);
    const fs = await import("node:fs/promises");
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.size > MAX_WARMUP_DOCUMENT_BYTES) {
        opened.delete(uri);
        return;
      }
      const handle = await fs.open(absolutePath, "r");
      try {
        const sample = Buffer.alloc(BINARY_CHECK_BYTES);
        const { bytesRead } = await handle.read(
          sample,
          0,
          BINARY_CHECK_BYTES,
          0
        );
        if (sample.subarray(0, bytesRead).includes(0)) {
          opened.delete(uri);
          return;
        }
      } finally {
        await handle.close();
      }
      const text = secretRedactionService.redactText(
        await fs.readFile(absolutePath, "utf8")
      );
      let document = session.documents.get(uri);
      if (!document) {
        document = {
          uri,
          tabs: new Map(),
          serverVersion: 1,
          syncedText: text,
          syncedVersion: 1,
          warmupReferences: 1,
        };
        session.documents.set(uri, document);
        await session.connection.sendNotification(LSP_METHODS.DID_OPEN, {
          textDocument: { uri, languageId, version: 1, text },
        });
      } else {
        document.warmupReferences = (document.warmupReferences ?? 0) + 1;
      }
    } catch (error) {
      opened.delete(uri);
      if (opened.size === 0) this.warmupDocuments.delete(session.id);
      throw error;
    }
  }

  async restartServer(id: string): Promise<void> {
    if (!this.options.backend.restartServer)
      throw new Error("This language server host does not support restart.");
    await this.options.backend.restartServer(id);
  }

  async requestWorkspaceApproval(): Promise<boolean> {
    return this.options.backend.requestWorkspaceApproval?.() ?? false;
  }

  getApprovedWorkspaceDefinitionIds(): string[] {
    return this.options.backend.getApprovedWorkspaceDefinitionIds?.() ?? [];
  }

  async stopServer(id: string): Promise<void> {
    if (!this.options.backend.stopManagedServer)
      throw new Error("This language server host does not support stop.");
    await this.options.backend.stopManagedServer(id);
  }

  async lookupSession(
    viewerPath: string,
    origin: LanguageServerRequestOrigin
  ): Promise<LanguageIntelligenceSessionLookup> {
    if (!this.options.isWorkspaceTrusted()) {
      return {
        session: null,
        reason: LANGUAGE_SERVER_RESOLUTION_REASONS.UNTRUSTED,
      };
    }
    if (!safeResolveWorkspacePath(viewerPath, this.roots)) {
      return {
        session: null,
        reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER,
      };
    }
    const resolution = await this.options.backend.resolveForPath(
      viewerPath,
      this.roots,
      origin
    );
    if (!this.options.isWorkspaceTrusted()) {
      return {
        session: null,
        reason: LANGUAGE_SERVER_RESOLUTION_REASONS.UNTRUSTED,
      };
    }
    if (!("descriptor" in resolution)) {
      return { session: null, reason: resolution.reason };
    }
    const session = await this.getOrCreateSession(resolution.descriptor, origin);
    return {
      session: {
        id: session.id,
        languageId: resolution.descriptor.languageId,
        capabilities: session.descriptor.capabilities,
      },
    };
  }

  async createProxy(
    serverId: string,
    send: (message: unknown) => void,
    canOpenPath: (viewerPath: string) => Promise<boolean>,
    fileEditOperations: {
      readFile: (
        viewerPath: string
      ) => Promise<{ content: string; readOnly?: boolean }>;
      writeFile: (viewerPath: string, content: string) => Promise<void>;
      notifyFileChanged: (viewerPath: string) => Promise<void>;
    } = {
      readFile: async () => ({ content: "", readOnly: true }),
      writeFile: async () => undefined,
      notifyFileChanged: async () => undefined,
    },
    invalidateClient?: (code: number, reason: string) => void
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
      ...fileEditOperations,
      documents: session.documents,
      onDispose: () => session.proxies.delete(proxy),
      onDocumentOpened: () =>
        this.options.backend.documentOpened?.(session.descriptor),
      onDocumentClosed: () =>
        this.options.backend.documentClosed?.(session.descriptor),
      onSessionInvalidated: invalidateClient,
    });
    session.proxies.add(proxy);
    return proxy;
  }

  async notifyWorkspaceFileChanged(
    viewerPath: string,
    type = 2
  ): Promise<void> {
    const absolutePath = safeResolveWorkspacePath(viewerPath, this.roots);
    if (!absolutePath) return;
    const uri = toServerFileUri(absolutePath);
    for (const pending of this.sessions.values()) {
      const session = await pending.catch(() => undefined);
      if (!session) continue;
      try {
        void Promise.resolve(
          session.connection.sendNotification(
            LSP_METHODS.DID_CHANGE_WATCHED_FILES,
            { changes: [{ uri, type }] }
          )
        ).catch(() => undefined);
      } catch {
        /* session may have been invalidated between lookup and send */
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pendingSessions = [...this.sessions.values()];
    const results = await Promise.allSettled(pendingSessions);
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      await this.closeWarmupDocuments(result.value);
      for (const proxy of [...result.value.proxies]) {
        try {
          proxy.dispose();
        } catch {
          /* one broken client must not prevent invalidating the rest */
        }
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.options.backend.dispose?.();
    this.sessions.clear();
    this.sessionsById.clear();
    this.backendStatusSubscription?.dispose();
    this.statusEvents.removeAllListeners();
  }

  private getOrCreateSession(
    descriptor: LanguageServerDescriptor,
    origin: LanguageServerRequestOrigin
  ): Promise<SharedServerSession> {
    const root = path.resolve(descriptor.rootPath);
    const key = `${descriptor.id}\n${root}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created = Promise.resolve(
      this.options.backend.getConnection(descriptor, origin)
    ).then((connection) => {
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
            ({ uri?: unknown } & Record<string, unknown>) | undefined;
          if (typeof params?.uri !== "string") return;
          const document = session.documents.get(
            canonicalServerFileUri(params.uri)
          );
          if (!document) return;
          for (const [proxy, buffer] of document.tabs) {
            if (buffer.text === document.syncedText) {
              void proxy.deliverServerMessage({
                jsonrpc: "2.0",
                method,
                params,
              }).catch((error: unknown) => Log.warn("[LanguageIntelligenceHost] Could not deliver language-server notification:", error));
            }
          }
          return;
        }
        for (const proxy of session.proxies) {
          void proxy.deliverServerMessage({
            jsonrpc: "2.0",
            method,
            ...(rawParams === undefined ? {} : { params: rawParams }),
          }).catch((error: unknown) => Log.warn("[LanguageIntelligenceHost] Could not deliver language-server notification:", error));
        }
      });
      connection.onRequest((method, params) => {
        const proxy = session.proxies.values().next().value;
        return proxy?.forwardServerRequest(method, params);
      });
      if (this.options.backend.listenConnection) {
        this.options.backend.listenConnection(connection);
      } else {
        connection.listen();
      }
      return session;
    });
    this.sessions.set(key, created);
    void created.catch((error: unknown) => {
      if (this.sessions.get(key) === created) this.sessions.delete(key);
      this.statusEvents.emit("change", {
        id: descriptor.id,
        rootPath: root,
        status: LANGUAGE_SERVER_STATUSES.CRASHED,
        detail: error instanceof Error ? error.message : String(error),
      } satisfies LanguageServerStatusChange);
    });
    void created
      .then((session) => {
        this.sessionsById.set(session.id, created);
      })
      .catch(() => undefined);
    return created;
  }

  private invalidateSession(serverId: string, rootPath: string): void {
    const key = `${serverId}\n${path.resolve(rootPath)}`;
    const pending = this.sessions.get(key);
    if (!pending) return;
    this.sessions.delete(key);
    void pending
      .then((session) => {
        this.sessionsById.delete(session.id);
        void (async () => {
          await this.closeWarmupDocuments(session);
          for (const proxy of [...session.proxies]) {
            try {
              proxy.invalidateSession();
            } catch {
              /* invalidate every tab even if one client callback throws */
            }
          }
        })();
      })
      .catch(() => undefined);
  }

  private async closeWarmupDocuments(
    session: SharedServerSession
  ): Promise<void> {
    const uris = this.warmupDocuments.get(session.id);
    if (!uris) return;
    this.warmupDocuments.delete(session.id);
    for (const uri of uris) {
      const document = session.documents.get(uri);
      if (document)
        document.warmupReferences = Math.max(
          0,
          (document.warmupReferences ?? 0) - 1
        );
      if (
        document &&
        (document.tabs.size > 0 || (document.warmupReferences ?? 0) > 0)
      )
        continue;
      try {
        await session.connection.sendNotification(LSP_METHODS.DID_CLOSE, {
          textDocument: { uri },
        });
      } catch {
        /* server may already have exited */
      }
      session.documents.delete(uri);
    }
  }
}
