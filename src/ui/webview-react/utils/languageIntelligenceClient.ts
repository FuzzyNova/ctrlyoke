import {
  LSPClient,
  Workspace,
  hoverTooltips,
  serverCompletion,
  serverDiagnostics,
} from "@codemirror/lsp-client";
import { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { WorkspaceFile } from "@codemirror/lsp-client";
import { LSP_VIEWER_URI_PREFIX } from "@root/types/HostedWorkspaceViewerTypes";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { WebviewLog } from "@utils/logger";
import {
  LanguageIntelligenceTransport,
  type LspWebSocketFactory,
  setWorkspaceEditHandler,
} from "./languageIntelligenceTransport";

interface ClientSession {
  client: LSPClient;
  workspace: WorkspaceViewerLspWorkspace;
  transport: LanguageIntelligenceTransport;
  refs: number;
  disposeTimer?: ReturnType<typeof setTimeout>;
  sessionEndedListeners: Set<() => void>;
  connectedListeners: Set<() => void>;
}

const SESSION_DISPOSE_GRACE_MS = 500;
const SESSION_CONNECT_TIMEOUT_MS = 15_000;

const sessions = new Map<string, ClientSession>();
const editorViews = new Map<string, EditorView>();
const viewListeners = new Map<string, Set<(view: EditorView) => void>>();

export function applyWorkspaceTextEdits(uri: string, edits: unknown[]): void {
  const view = editorViews.get(uri);
  if (!view) return;
  const changes = edits
    .flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const edit = value as {
        range?: {
          start?: { line?: number; character?: number };
          end?: { line?: number; character?: number };
        };
        newText?: unknown;
      };
      if (
        typeof edit.newText !== "string" ||
        !edit.range?.start ||
        !edit.range.end
      )
        return [];
      const offset = (position: { line?: number; character?: number }) => {
        if (
          typeof position.line !== "number" ||
          typeof position.character !== "number"
        )
          return 0;
        if (position.line >= view.state.doc.lines) return view.state.doc.length;
        const line = view.state.doc.line(Math.max(1, position.line + 1));
        return Math.min(line.to, line.from + Math.max(0, position.character));
      };
      const from = offset(edit.range.start);
      const to = offset(edit.range.end);
      return [{ from, to, insert: edit.newText }];
    })
    .sort((a, b) => a.from - b.from);
  if (changes.length) view.dispatch({ changes });
}
setWorkspaceEditHandler(applyWorkspaceTextEdits);

export function workspaceFileUri(filePath: string): string {
  const encodedPath = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${LSP_VIEWER_URI_PREFIX}${encodedPath}`;
}

export function viewerPathFromUri(uri: string): string | null {
  try {
    const pathname = new URL(uri).pathname;
    const prefix = new URL(LSP_VIEWER_URI_PREFIX).pathname;
    if (!pathname.startsWith(prefix)) return null;
    return pathname
      .slice(prefix.length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
  } catch {
    return null;
  }
}

export function requestLanguageIntelligence(
  sessionId: string,
  method: string,
  params: unknown
): Promise<unknown> {
  const session = sessions.get(sessionId);
  if (!session) {
    return Promise.reject(new Error("Language server session is unavailable"));
  }
  session.client.sync();
  return session.client
    .request<unknown, unknown>(method, params)
    .catch((error: unknown) => {
      WebviewLog.warn(
        `[languageIntelligenceClient] ${method} failed: ${String(error)}`
      );
      return null;
    });
}

export function registerLanguageIntelligenceView(
  filePath: string,
  view: EditorView
): () => void {
  const uri = workspaceFileUri(filePath);
  editorViews.set(uri, view);
  for (const listener of viewListeners.get(uri) ?? []) listener(view);
  return () => {
    if (editorViews.get(uri) === view) editorViews.delete(uri);
  };
}

function waitForLanguageIntelligenceView(
  uri: string
): Promise<EditorView | null> {
  const current = editorViews.get(uri);
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const listeners = viewListeners.get(uri) ?? new Set();
    const finish = (view: EditorView | null) => {
      clearTimeout(timeout);
      listeners.delete(onView);
      if (listeners.size === 0) viewListeners.delete(uri);
      resolve(view);
    };
    const onView = (view: EditorView) => finish(view);
    listeners.add(onView);
    viewListeners.set(uri, listeners);
    timeout = setTimeout(() => finish(null), 15_000);
  });
}

class WorkspaceViewerLspWorkspace extends Workspace {
  files: WorkspaceFile[] = [];

  syncFiles() {
    const updates: {
      file: WorkspaceFile;
      prevDoc: Text;
      changes: ChangeSet;
    }[] = [];
    for (const file of this.files) {
      const view = file.getView();
      if (!view) continue;
      const nextDoc = Text.of(view.state.doc.toString().split("\n"));
      if (file.doc.eq(nextDoc)) continue;
      const prevDoc = file.doc;
      const changes = ChangeSet.of(
        { from: 0, to: prevDoc.length, insert: nextDoc.toString() },
        prevDoc.length
      );
      file.doc = nextDoc;
      file.version += 1;
      updates.push({ file, prevDoc, changes });
    }
    return updates;
  }

  /**
   * Open a file the server should see although no editor shows it, e.g. the
   * origin of a references query restored from a URL. An editor that opens
   * the file later takes it over; the returned close is then a no-op.
   */
  openDetachedFile(
    uri: string,
    languageId: string,
    content: string
  ): () => void {
    if (this.getFile(uri)) return () => {};
    const file: WorkspaceFile = {
      uri,
      languageId,
      version: 1,
      doc: Text.of(content.split(/\r?\n/)),
      getView: () => null,
    };
    this.files.push(file);
    this.client.didOpen(file);
    return () => {
      if (!this.files.includes(file) || file.getView()) return;
      this.files = this.files.filter((candidate) => candidate !== file);
      this.client.didClose(uri);
    };
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    const existing = this.files.find((file) => file.uri === uri);
    if (existing) {
      existing.getView = () => view;
      return;
    }
    const file: WorkspaceFile = {
      uri,
      languageId,
      version: 1,
      doc: Text.of(view.state.doc.toString().split("\n")),
      getView: () => view,
    };
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string, view: EditorView): void {
    const file = this.files.find((candidate) => candidate.uri === uri);
    if (!file || file.getView() !== view) return;
    this.files = this.files.filter((candidate) => candidate !== file);
    this.client.didClose(uri);
  }

  updateFile(
    uri: string,
    update: Parameters<Workspace["updateFile"]>[1]
  ): void {
    const file = this.getFile(uri);
    const view = file?.getView();
    if (view) view.dispatch(update);
  }

  async requestFile(
    uri: string,
    startLine?: number,
    endLine?: number
  ): Promise<WorkspaceFile | null> {
    const existing = this.getFile(uri);
    if (existing) return existing;
    const filePath = viewerPathFromUri(uri);
    if (!filePath) return null;
    useWorkspaceViewerStore
      .getState()
      .openToFile(
        filePath,
        startLine === undefined ? undefined : startLine + 1,
        endLine === undefined ? undefined : endLine + 1
      );
    await waitForLanguageIntelligenceView(uri);
    return this.getFile(uri);
  }

  async displayFile(
    uri: string,
    startLine?: number,
    endLine?: number
  ): Promise<EditorView | null> {
    const existing = this.getFile(uri)?.getView();
    if (existing) return existing;
    const filePath = viewerPathFromUri(uri);
    if (!filePath) return null;
    useWorkspaceViewerStore
      .getState()
      .openToFile(
        filePath,
        startLine === undefined ? undefined : startLine + 1,
        endLine === undefined ? undefined : endLine + 1
      );
    return waitForLanguageIntelligenceView(uri);
  }
}

/** The text an open editor currently holds for `filePath`, if any. */
export function languageIntelligenceDocumentText(
  filePath: string
): string | null {
  return (
    editorViews.get(workspaceFileUri(filePath))?.state.doc.toString() ?? null
  );
}

function retainSession(
  sessionId: string,
  socketUrl: string,
  createSocket: LspWebSocketFactory
): { session: ClientSession; release: () => void } {
  let session = sessions.get(sessionId);
  if (!session) {
    let client: LSPClient;
    let workspace: WorkspaceViewerLspWorkspace | undefined;
    const sessionEndedListeners = new Set<() => void>();
    const connectedListeners = new Set<() => void>();
    const transport = new LanguageIntelligenceTransport(
      socketUrl,
      createSocket,
      () => {
        client.connect(transport);
        for (const listener of [...connectedListeners]) listener();
      },
      () => {
        if (client.connected) client.disconnect();
      },
      () => {
        for (const listener of sessionEndedListeners) listener();
      }
    );
    client = new LSPClient({
      // Keep phase 3 navigation/rename keymaps out until their viewer UX exists.
      extensions: [serverCompletion(), hoverTooltips(), serverDiagnostics()],
      workspace: (connectedClient) =>
        (workspace = new WorkspaceViewerLspWorkspace(connectedClient)),
    });
    if (!workspace) throw new Error("LSP client did not create its workspace");
    session = {
      client,
      workspace,
      transport,
      refs: 0,
      sessionEndedListeners,
      connectedListeners,
    };
    sessions.set(sessionId, session);
    transport.start();
  }
  if (session.disposeTimer) {
    clearTimeout(session.disposeTimer);
    session.disposeTimer = undefined;
  }
  session.refs += 1;
  const retained = session;
  let released = false;
  return {
    session: retained,
    release: () => {
      if (released) return;
      released = true;
      const current = sessions.get(sessionId);
      if (current !== retained) return;
      current.refs -= 1;
      if (current.refs > 0 || current.disposeTimer) return;
      current.disposeTimer = setTimeout(() => {
        if (sessions.get(sessionId) !== current || current.refs > 0) return;
        sessions.delete(sessionId);
        current.client.disconnect();
        current.transport.dispose();
      }, SESSION_DISPOSE_GRACE_MS);
    },
  };
}

/**
 * Resolves once the session's socket is open and the server initialized.
 * `LSPClient.request` rejects outright before the transport attaches, which
 * an editor never notices (it waits for the session) but a query that starts
 * the session itself, like references restored from a URL, does.
 */
function waitForConnection(session: ClientSession): Promise<null> {
  if (session.client.connected) return session.client.initializing;
  return new Promise<void>((resolve, reject) => {
    const onConnected = () => {
      clearTimeout(timer);
      session.connectedListeners.delete(onConnected);
      resolve();
    };
    const timer = setTimeout(() => {
      session.connectedListeners.delete(onConnected);
      reject(new Error("Language server connection timed out"));
    }, SESSION_CONNECT_TIMEOUT_MS);
    session.connectedListeners.add(onConnected);
  }).then(() => session.client.initializing);
}

export function acquireLanguageIntelligenceClient(
  sessionId: string,
  languageId: string,
  filePath: string,
  socketUrl: string,
  createSocket: LspWebSocketFactory,
  onSessionEnded?: () => void
): { extension: ReturnType<LSPClient["plugin"]>; release: () => void } {
  const { session, release } = retainSession(
    sessionId,
    socketUrl,
    createSocket
  );
  const sessionEnded = () => onSessionEnded?.();
  if (onSessionEnded) session.sessionEndedListeners.add(sessionEnded);
  return {
    extension: session.client.plugin(workspaceFileUri(filePath), languageId),
    release: () => {
      session.sessionEndedListeners.delete(sessionEnded);
      release();
    },
  };
}

/**
 * Run `request` against a session with `filePath` open on the server, opening
 * it from `loadContent` when no editor has it open. Used for queries that
 * must work without an editor, such as references restored from a URL.
 */
export async function withLanguageIntelligenceDocument<T>(
  sessionId: string,
  languageId: string,
  filePath: string,
  socketUrl: string,
  createSocket: LspWebSocketFactory,
  loadContent: () => Promise<string>,
  request: () => Promise<T>
): Promise<T> {
  const { session, release } = retainSession(
    sessionId,
    socketUrl,
    createSocket
  );
  let closeDocument = () => {};
  try {
    await waitForConnection(session);
    const uri = workspaceFileUri(filePath);
    if (!session.workspace.getFile(uri)) {
      const content = await loadContent();
      closeDocument = session.workspace.openDetachedFile(
        uri,
        languageId,
        content
      );
    }
    return await request();
  } finally {
    closeDocument();
    release();
  }
}
