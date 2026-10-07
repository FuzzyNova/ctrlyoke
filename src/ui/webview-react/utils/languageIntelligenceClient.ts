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
import {
  LanguageIntelligenceTransport,
  type LspWebSocketFactory,
} from "./languageIntelligenceTransport";

interface ClientSession {
  client: LSPClient;
  transport: LanguageIntelligenceTransport;
  refs: number;
}

const sessions = new Map<string, ClientSession>();
const editorViews = new Map<string, EditorView>();
const viewListeners = new Map<string, Set<(view: EditorView) => void>>();

export function workspaceFileUri(filePath: string): string {
  const encodedPath = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${LSP_VIEWER_URI_PREFIX}${encodedPath}`;
}

function viewerPathFromUri(uri: string): string | null {
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

function waitForLanguageIntelligenceView(uri: string): Promise<EditorView | null> {
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

  updateFile(uri: string, update: Parameters<Workspace["updateFile"]>[1]): void {
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
    useWorkspaceViewerStore.getState().openToFile(
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
    useWorkspaceViewerStore.getState().openToFile(
      filePath,
      startLine === undefined ? undefined : startLine + 1,
      endLine === undefined ? undefined : endLine + 1
    );
    return waitForLanguageIntelligenceView(uri);
  }
}

export function acquireLanguageIntelligenceClient(
  sessionId: string,
  languageId: string,
  filePath: string,
  socketUrl: string,
  createSocket: LspWebSocketFactory
): { extension: ReturnType<LSPClient["plugin"]>; release: () => void } {
  let session = sessions.get(sessionId);
  if (!session) {
    let client: LSPClient;
    const transport = new LanguageIntelligenceTransport(
      socketUrl,
      createSocket,
      () => client.connect(transport),
      () => {
        if (client.connected) client.disconnect();
      }
    );
    client = new LSPClient({
      // Keep phase 3 navigation/rename keymaps out until their viewer UX exists.
      extensions: [serverCompletion(), hoverTooltips(), serverDiagnostics()],
      workspace: (connectedClient) =>
        new WorkspaceViewerLspWorkspace(connectedClient),
    });
    session = { client, transport, refs: 0 };
    sessions.set(sessionId, session);
    transport.start();
  }
  session.refs += 1;
  let released = false;
  return {
    extension: session.client.plugin(workspaceFileUri(filePath), languageId),
    release: () => {
      if (released) return;
      released = true;
      const current = sessions.get(sessionId);
      if (!current) return;
      current.refs -= 1;
      if (current.refs > 0) return;
      sessions.delete(sessionId);
      current.client.disconnect();
      current.transport.dispose();
    },
  }
}
