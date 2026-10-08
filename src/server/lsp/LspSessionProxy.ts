import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CancellationTokenSource, type MessageConnection } from "vscode-jsonrpc";
import { secretRedactionService } from "../../utils/SecretRedactionService";
import { LSP_SESSION_INVALIDATION_CLOSE } from "../../types/DashboardConstants";
import { toViewerPath } from "../../platform/WorkspaceViewerPath";
import type { LanguageServerDescriptor } from "./LanguageServerBackend";
import {
  LSP_METHODS,
  LSP_READ_ONLY_URI_SCHEME,
  fromLspViewerUri,
  toLspViewerUri,
  type JsonRpcMessage,
} from "./LspProtocol";
import type { SharedDocument } from "./LspSharedDocument";
import type { WorkspacePathContext } from "./WorkspacePathContainment";
import { safeResolveWorkspacePath } from "./WorkspacePathContainment";

interface BufferState {
  readonly viewerPath: string;
  readonly serverUri: string;
  readonly languageId: string;
  text: string;
  version: number;
}

interface ProxyOptions {
  readonly descriptor: LanguageServerDescriptor;
  readonly connection: MessageConnection;
  readonly roots: WorkspacePathContext;
  readonly send: (message: unknown) => void;
  readonly canOpenPath: (viewerPath: string) => Promise<boolean>;
  readonly readFile: (viewerPath: string) => Promise<{ content: string; readOnly?: boolean }>;
  readonly writeFile: (viewerPath: string, content: string) => Promise<void>;
  readonly notifyFileChanged: (viewerPath: string) => Promise<void>;
  readonly documents: Map<string, SharedDocument>;
  readonly onDispose: () => void;
  readonly onDocumentOpened?: () => void;
  readonly onDocumentClosed?: () => void;
  readonly onSessionInvalidated?: (code: number, reason: string) => void;
}

const INVALID_REQUEST = -32600;

/** Adapts one browser LSP connection to a shared language-server connection. */
export class LspSessionProxy {
  private readonly buffers = new Map<string, BufferState>();
  private readonly pendingServerRequests = new Map<
    string | number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly pendingClientRequests = new Map<string | number, CancellationTokenSource>();
  private messageQueue: Promise<void> = Promise.resolve();
  private nextServerRequestId = 1;
  private nextClientRequestId = 1;
  private disposed = false;

  constructor(private readonly options: ProxyOptions) {}

  handleMessage(message: JsonRpcMessage): Promise<void> {
    const handling = this.messageQueue.then(() => this.processMessage(message));
    this.messageQueue = handling.catch(() => undefined);
    return handling;
  }

  invalidateSession(): void {
    this.options.onSessionInvalidated?.(LSP_SESSION_INVALIDATION_CLOSE.CODE, LSP_SESSION_INVALIDATION_CLOSE.REASON);
    this.dispose();
  }

  private async processMessage(message: JsonRpcMessage): Promise<void> {
    if (this.disposed || !message || message.jsonrpc !== "2.0") return;
    if ("method" in message) {
      if ("id" in message) {
        await this.handleRequest(message);
      } else {
        await this.handleNotification(message);
      }
      return;
    }
    this.handleServerResponse(message);
  }

  async forwardServerRequest(method: string, params: unknown): Promise<unknown> {
    if (this.disposed) throw new Error("LSP client is disconnected.");
    if (method === LSP_METHODS.APPLY_EDIT) {
      const edit = (params as { edit?: unknown } | undefined)?.edit;
      await this.applyWorkspaceEdit(edit, false);
      return { applied: true };
    }
    const id = `server-${this.nextServerRequestId++}`;
    const rewrittenParams = await this.rewriteUris(params, false);
    const response = new Promise<unknown>((resolve, reject) => {
      this.pendingServerRequests.set(id, { resolve, reject });
    });
    this.sendToClient({ jsonrpc: "2.0", id, method, params: rewrittenParams });
    return response;
  }

  async deliverServerMessage(message: unknown): Promise<void> {
    if (this.disposed) return;
    this.sendToClient(await this.rewriteUris(message, false));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of this.buffers.values()) {
      const document = this.options.documents.get(buffer.serverUri);
      if (!document) continue;
      document.tabs.delete(this);
      if (document.tabs.size === 0) {
        this.options.onDocumentClosed?.();
        if ((document.warmupReferences ?? 0) === 0) {
          this.options.documents.delete(buffer.serverUri);
          void this.options.connection.sendNotification(LSP_METHODS.DID_CLOSE, {
            textDocument: { uri: buffer.serverUri },
          }).catch(() => undefined);
        }
      }
    }
    this.buffers.clear();
    for (const pending of this.pendingServerRequests.values()) {
      pending.reject(new Error("LSP client disconnected."));
    }
    this.pendingServerRequests.clear();
    for (const source of this.pendingClientRequests.values()) source.cancel();
    this.pendingClientRequests.clear();
    this.options.onDispose();
  }

  private async handleRequest(
    request: Extract<JsonRpcMessage, { method: string; id: string | number }>
  ): Promise<void> {
    if (request.method === LSP_METHODS.INITIALIZE) {
      this.sendResponse(request.id, {
        capabilities: this.options.descriptor.capabilities,
        ...(this.options.descriptor.serverInfo
          ? { serverInfo: this.options.descriptor.serverInfo }
          : {}),
      });
      return;
    }
    if (request.method === LSP_METHODS.SHUTDOWN) {
      this.sendResponse(request.id, null);
      return;
    }

    let params: unknown;
    try {
      params = await this.rewriteUris(request.params, true);
      await this.validateRequestDocument(request.params);
      await this.resyncForRequest(request.method, params);
    } catch (error) {
      this.sendError(request.id, INVALID_REQUEST, String(error));
      return;
    }

    const cancellation = new CancellationTokenSource();
    this.pendingClientRequests.set(request.id, cancellation);
    void this.options.connection
      .sendRequest(request.method, params, cancellation.token)
      .then(async (result) => {
        let rewrittenResult = result;
        if (request.method === LSP_METHODS.RENAME) {
          await this.applyWorkspaceEdit(result, true);
          // Open-buffer text is updated through the browser's didChange event.
          rewrittenResult = null;
        } else {
          rewrittenResult = await this.rewriteUris(result, false);
        }
        this.sendToClient({ jsonrpc: "2.0", id: request.id, result: rewrittenResult });
      })
      .catch((error: unknown) => {
        this.sendError(request.id, INVALID_REQUEST, String(error));
      })
      .finally(() => {
        this.pendingClientRequests.delete(request.id);
        cancellation.dispose();
      });
  }

  private async handleNotification(
    notification: Extract<JsonRpcMessage, { method: string; id?: never }>
  ): Promise<void> {
    if (notification.method === LSP_METHODS.EXIT) {
      this.dispose();
      return;
    }
    if (notification.method === LSP_METHODS.INITIALIZED) return;
    if (notification.method === LSP_METHODS.DID_OPEN) {
      await this.openDocument(notification.params);
      return;
    }
    if (notification.method === LSP_METHODS.DID_CHANGE) {
      await this.changeDocument(notification.params);
      return;
    }
    if (notification.method === LSP_METHODS.DID_CLOSE) {
      await this.closeDocument(notification.params);
      return;
    }
    if (notification.method === LSP_METHODS.CANCEL_REQUEST) {
      const id = (notification.params as { id?: unknown } | undefined)?.id;
      if (typeof id === "string" || typeof id === "number") {
        this.pendingClientRequests.get(id)?.cancel();
      }
      return;
    }
    let params: unknown;
    try {
      params = await this.rewriteUris(notification.params, true);
    } catch {
      return;
    }
    await this.options.connection.sendNotification(notification.method, params);
  }

  private handleServerResponse(response: {
    id: string | number | null;
    result?: unknown;
    error?: { message?: string };
  }): void {
    if (response.id === null) return;
    const pending = this.pendingServerRequests.get(response.id);
    if (!pending) return;
    this.pendingServerRequests.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message ?? "LSP client request failed."));
      return;
    }
    void this.rewriteUris(response.result, true)
      .then((result) => pending.resolve(result))
      .catch((error: unknown) => pending.reject(new Error(String(error))));
  }

  private async openDocument(value: unknown): Promise<void> {
    const params = value as {
      textDocument?: {
        uri?: unknown;
        languageId?: unknown;
        version?: unknown;
        text?: unknown;
      };
    };
    const document = params?.textDocument;
    if (
      typeof document?.uri !== "string" ||
      typeof document.text !== "string" ||
      typeof document.languageId !== "string"
    ) return;
    const translated = this.resolveClientUri(document.uri);
    if (!translated || !(await this.options.canOpenPath(translated.viewerPath))) {
      return;
    }
    const state: BufferState = {
      ...translated,
      languageId: document.languageId,
      text: document.text,
      version: typeof document.version === "number" ? document.version : 1,
    };
    this.buffers.set(document.uri, state);
    let shared = this.options.documents.get(state.serverUri);
    const isFirstOpen = !shared;
    if (!shared) {
      shared = { uri: state.serverUri, tabs: new Map(), serverVersion: 1 };
      this.options.documents.set(state.serverUri, shared);
    }
    shared.tabs.set(this, { text: state.text, version: state.version });
    if (shared.tabs.size === 1) this.options.onDocumentOpened?.();
    if (isFirstOpen) {
      await this.options.connection.sendNotification(LSP_METHODS.DID_OPEN, {
        textDocument: {
          uri: state.serverUri,
          languageId: state.languageId,
          version: shared.serverVersion,
          text: state.text,
        },
      });
      shared.syncedText = state.text;
      shared.syncedVersion = shared.serverVersion;
    }
  }

  private async changeDocument(value: unknown): Promise<void> {
    const params = value as {
      textDocument?: { uri?: unknown; version?: unknown };
      contentChanges?: Array<{ text?: unknown; range?: unknown }>;
    };
    const clientUri = params?.textDocument?.uri;
    if (typeof clientUri !== "string") return;
    const state = this.buffers.get(clientUri);
    if (!state) return;
    const changes = params.contentChanges ?? [];
    for (const change of changes) {
      if (typeof change.text !== "string") continue;
      state.text = change.range
        ? applyTextChange(state.text, change.range, change.text)
        : change.text;
    }
    if (typeof params.textDocument?.version === "number") {
      state.version = params.textDocument.version;
    } else {
      state.version += 1;
    }
    const shared = this.options.documents.get(state.serverUri);
    if (!shared) return;
    shared.tabs.set(this, { text: state.text, version: state.version });
    await this.sendFullTextChange(shared, state);
  }

  private async closeDocument(value: unknown): Promise<void> {
    const params = value as { textDocument?: { uri?: unknown } };
    const clientUri = params?.textDocument?.uri;
    if (typeof clientUri !== "string") return;
    const state = this.buffers.get(clientUri);
    if (!state) return;
    this.buffers.delete(clientUri);
    const shared = this.options.documents.get(state.serverUri);
    if (!shared) return;
    shared.tabs.delete(this);
    if (shared.tabs.size === 0) this.options.onDocumentClosed?.();
    if (shared.tabs.size > 0 || (shared.warmupReferences ?? 0) > 0) return;
    this.options.documents.delete(state.serverUri);
    await this.options.connection.sendNotification(LSP_METHODS.DID_CLOSE, {
      textDocument: { uri: state.serverUri },
    });
  }

  private async resyncForRequest(method: string, params: unknown): Promise<void> {
    const uri = findTextDocumentUri(params);
    if (!uri) return;
    const state =
      this.buffers.get(uri) ??
      [...this.buffers.values()].find((buffer) => buffer.serverUri === uri);
    if (!state) return;
    const shared = this.options.documents.get(state.serverUri);
    if (shared && shared.syncedText !== state.text) {
      await this.sendFullTextChange(shared, state);
    }
    void method;
  }

  private async validateRequestDocument(params: unknown): Promise<void> {
    const clientUri = findTextDocumentUri(params);
    if (!clientUri || this.buffers.has(clientUri)) return;
    const translated = this.resolveClientUri(clientUri);
    if (!translated || !(await this.options.canOpenPath(translated.viewerPath))) {
      throw new Error("Language server request targets a file unavailable in the workspace viewer.");
    }
  }

  private async sendFullTextChange(
    shared: SharedDocument,
    state: BufferState
  ): Promise<void> {
    shared.serverVersion += 1;
    await this.options.connection.sendNotification(LSP_METHODS.DID_CHANGE, {
      textDocument: { uri: state.serverUri, version: shared.serverVersion },
      contentChanges: [{ text: state.text }],
    });
    shared.syncedText = state.text;
    shared.syncedVersion = shared.serverVersion;
  }

  private resolveClientUri(clientUri: string):
    | { viewerPath: string; serverUri: string }
    | undefined {
    try {
      const parsed = new URL(clientUri);
      if (parsed.protocol !== "file:") return undefined;
      const viewerPath = fromLspViewerUri(clientUri) ?? toViewerPath(fileURLToPath(parsed), {
            primaryRoot: this.options.roots.workspaceRoot,
            namedRoots: this.options.roots.namedRoots,
          });
      const absolutePath = safeResolveWorkspacePath(viewerPath, this.options.roots);
      if (!absolutePath) return undefined;
      return { viewerPath, serverUri: pathToFileURL(absolutePath).toString() };
    } catch {
      return undefined;
    }
  }

  private async rewriteUris(value: unknown, inbound: boolean): Promise<unknown> {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.rewriteUris(item, inbound)));
    }
    if (!value || typeof value !== "object") return value;
    const rewritten: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "uri" || key.endsWith("Uri")) && typeof entry === "string") {
        rewritten[key] = inbound
          ? this.resolveInboundUri(entry)
          : this.resolveOutboundUri(entry);
      } else if (key.toLowerCase().startsWith("file:")) {
        rewritten[inbound ? this.resolveInboundUri(key) : this.resolveOutboundUri(key)] =
          await this.rewriteUris(entry, inbound);
      } else {
        rewritten[key] = await this.rewriteUris(entry, inbound);
      }
    }
    return rewritten;
  }

  private resolveInboundUri(uri: string): string {
    const translated = this.resolveClientUri(uri);
    if (!translated) throw new Error(`URI is outside the workspace: ${uri}`);
    return translated.serverUri;
  }

  private resolveOutboundUri(uri: string): string {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "file:") return uri;
      const absolutePath = fileURLToPath(parsed);
      const viewerPath = toViewerPath(absolutePath, {
        primaryRoot: this.options.roots.workspaceRoot,
        namedRoots: this.options.roots.namedRoots,
      });
      if (!safeResolveWorkspacePath(viewerPath, this.options.roots)) {
        return `${LSP_READ_ONLY_URI_SCHEME}${encodeURIComponent(path.basename(absolutePath))}`;
      }
      return toLspViewerUri(viewerPath);
    } catch {
      return uri;
    }
  }

  private async applyWorkspaceEdit(value: unknown, confirmUnopened: boolean): Promise<void> {
    if (!value || typeof value !== "object") return;
    const edit = value as {
      changes?: Record<string, Array<{ range?: unknown; newText?: unknown }>>;
      documentChanges?: Array<{
        textDocument?: { uri?: unknown };
        edits?: Array<{ range?: unknown; newText?: unknown }>;
      }>;
    };
    const byPath = new Map<string, Array<{ range?: unknown; newText?: unknown }>>();
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
      if (typeof uri !== "string" || !Array.isArray(edits)) throw new Error("Invalid workspace edit.");
      byPath.set(this.viewerPathFromServerUri(uri), edits);
    }
    for (const change of edit.documentChanges ?? []) {
      const uri = change.textDocument?.uri;
      if (typeof uri !== "string" || !Array.isArray(change.edits)) throw new Error("Unsupported workspace edit operation.");
      const existing = byPath.get(this.viewerPathFromServerUri(uri)) ?? [];
      byPath.set(this.viewerPathFromServerUri(uri), [...existing, ...change.edits]);
    }
    if (byPath.size === 0) return;

    // Validate the whole edit before mutating any buffer or file.
    const resolved = [...byPath].map(([viewerPath, edits]) => {
      const serverUri = this.resolveClientUri(toLspViewerUri(viewerPath))?.serverUri;
      if (!serverUri) throw new Error(`Workspace edit path is outside the workspace: ${viewerPath}`);
      return { viewerPath, serverUri, edits };
    });
    for (const file of resolved) {
      if (!(await this.options.canOpenPath(file.viewerPath))) {
        throw new Error(`Workspace edit targets a read-only file: ${file.viewerPath}`);
      }
    }
    const unopened = resolved.filter(({ serverUri }) => !this.options.documents.get(serverUri)?.tabs.size);
    if (confirmUnopened && unopened.length > 0 && !(await this.confirmUnopenedRename(unopened.length))) {
      throw new Error("Rename cancelled.");
    }

    for (const file of resolved) {
      const shared = this.options.documents.get(file.serverUri);
      if (shared?.tabs.size) {
        this.applyEditsToOpenBuffer(file.serverUri, file.edits);
      } else {
        const response = await this.options.readFile(file.viewerPath);
        if (response.readOnly) throw new Error(`Workspace edit targets a read-only file: ${file.viewerPath}`);
        const content = applyLspTextEdits(response.content, file.edits);
        await this.options.writeFile(file.viewerPath, content);
        await this.options.notifyFileChanged(file.viewerPath);
      }
    }
  }

  private applyEditsToOpenBuffer(
    serverUri: string,
    edits: Array<{ range?: unknown; newText?: unknown }>
  ): void {
    const shared = this.options.documents.get(serverUri);
    if (!shared) return;
    for (const [proxy] of shared.tabs) {
      const state = [...proxy.buffers.values()].find((buffer) => buffer.serverUri === serverUri);
      if (!state) continue;
      proxy.sendToClient({
        jsonrpc: "2.0",
        method: LSP_METHODS.APPLY_WORKSPACE_TEXT_EDITS,
        params: { uri: toLspViewerUri(state.viewerPath), edits },
      });
    }
  }

  private viewerPathFromServerUri(uri: string): string {
    let absolutePath: string;
    try { absolutePath = fileURLToPath(uri); } catch { throw new Error(`Invalid workspace edit URI: ${uri}`); }
    const viewerPath = toViewerPath(absolutePath, {
      primaryRoot: this.options.roots.workspaceRoot,
      namedRoots: this.options.roots.namedRoots,
    });
    if (!safeResolveWorkspacePath(viewerPath, this.options.roots)) {
      throw new Error(`Workspace edit URI is outside the workspace: ${uri}`);
    }
    return viewerPath;
  }

  private async confirmUnopenedRename(fileCount: number): Promise<boolean> {
    const id = `confirm-${this.nextClientRequestId++}`;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pendingServerRequests.set(id, { resolve, reject });
    });
    this.sendToClient({
      jsonrpc: "2.0",
      id,
      method: LSP_METHODS.CONFIRM_WORKSPACE_RENAME,
      params: { fileCount },
    });
    return (await response) === true;
  }

  private sendResponse(id: string | number, result: unknown): void {
    this.sendToClient({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: string | number, code: number, message: string): void {
    this.sendToClient({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private sendToClient(message: unknown): void {
    this.options.send(secretRedactionService.redactValue(message));
  }
}

function findTextDocumentUri(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const document = (value as { textDocument?: { uri?: unknown } }).textDocument;
  return typeof document?.uri === "string" ? document.uri : undefined;
}

function applyTextChange(text: string, range: unknown, replacement: string): string {
  const candidate = range as {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
  if (
    typeof candidate.start?.line !== "number" ||
    typeof candidate.start.character !== "number" ||
    typeof candidate.end?.line !== "number" ||
    typeof candidate.end.character !== "number"
  ) return text;
  const offset = (line: number, character: number): number => {
    let index = 0;
    for (let currentLine = 0; currentLine < line; currentLine += 1) {
      const next = text.indexOf("\n", index);
      if (next < 0) return text.length;
      index = next + 1;
    }
    return Math.min(text.length, index + character);
  };
  const start = offset(candidate.start.line, candidate.start.character);
  const end = offset(candidate.end.line, candidate.end.character);
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function applyLspTextEdits(
  text: string,
  edits: Array<{ range?: unknown; newText?: unknown }>
): string {
  const changes = edits
    .filter((edit) => typeof edit.newText === "string")
    .map((edit) => ({ range: edit.range, text: edit.newText as string }))
    .sort((a, b) => {
      const left = a.range as { start?: { line?: number; character?: number } };
      const right = b.range as { start?: { line?: number; character?: number } };
      return (right.start?.line ?? 0) - (left.start?.line ?? 0) ||
        (right.start?.character ?? 0) - (left.start?.character ?? 0);
    });
  let updated = text;
  for (const change of changes) updated = applyTextChange(updated, change.range, change.text);
  return updated;
}
