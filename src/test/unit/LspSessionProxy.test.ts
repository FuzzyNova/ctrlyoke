import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";
import { suite, test } from "mocha";
import { LanguageIntelligenceHost } from "../../server/lsp/LanguageIntelligenceHost";
import {
  LANGUAGE_SERVER_REQUEST_ORIGINS,
  LSP_METHODS,
} from "../../types/DashboardConstants";
import {
  LSP_READ_ONLY_URI_SCHEME,
  LSP_VIEWER_URI_PREFIX,
} from "../../server/lsp/LspProtocol";
import {
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";
import { InMemoryLanguageServerBackend } from "../helpers/InMemoryLanguageServerBackend";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("LspSessionProxy", () => {
  let workspaceRoot: string;
  let backend: InMemoryLanguageServerBackend;
  let host: LanguageIntelligenceHost;
  let sessionId: string;
  let clientA: unknown[];
  let clientB: unknown[];
  let proxyA: Awaited<ReturnType<LanguageIntelligenceHost["createProxy"]>>;
  let proxyB: Awaited<ReturnType<LanguageIntelligenceHost["createProxy"]>>;
  let releaseRedactor: (() => void) | undefined;

  setup(async () => {
    workspaceRoot = makeTempDir("ctrlyoke-lsp-proxy-");
    fs.mkdirSync(path.join(workspaceRoot, "src"));
    fs.writeFileSync(
      path.join(workspaceRoot, "src", "main.ts"),
      "const value = 1;\n"
    );
    backend = new InMemoryLanguageServerBackend(workspaceRoot);
    host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    clientA = [];
    clientB = [];
    const lookup = await host.lookupSession(
      "src/main.ts",
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok(lookup.session);
    sessionId = lookup.session.id;
    proxyA = await host.createProxy(
      sessionId,
      (message) => clientA.push(message),
      async () => true
    );
    proxyB = await host.createProxy(
      sessionId,
      (message) => clientB.push(message),
      async () => true
    );
    assert.ok(proxyA);
    assert.ok(proxyB);
  });

  teardown(() => {
    releaseRedactor?.();
    releaseRedactor = undefined;
    proxyA?.dispose();
    proxyB?.dispose();
    host?.dispose();
    removeTempDir(workspaceRoot);
  });

  test("rewrites request ids independently for two browser clients", async () => {
    backend.requestHandler = (_method, params) => ({
      marker: (params as { marker: string }).marker,
    });
    await open(proxyA!, "client-a");
    await open(proxyB!, "client-b");
    await flushMessages();
    await requestHover(proxyA!, clientA, 1, "client-a");
    await requestHover(proxyB!, clientB, 1, "client-b");

    assert.ok(
      backend.requests.length >= 2,
      `requests=${JSON.stringify(backend.requests)}`
    );
    assert.strictEqual((clientA[0] as { id: number }).id, 1);
    assert.strictEqual((clientB[0] as { id: number }).id, 1);
    assert.deepStrictEqual((clientA[0] as { result: unknown }).result, {
      marker: "client-a",
    });
    assert.deepStrictEqual((clientB[0] as { result: unknown }).result, {
      marker: "client-b",
    });
  });

  test("answers initialize from the cached server capabilities", async () => {
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: LSP_METHODS.INITIALIZE,
      params: {},
    });
    assert.deepStrictEqual((clientA[0] as { result: unknown }).result, {
      capabilities: { hoverProvider: true, definitionProvider: true },
      serverInfo: { name: "fake-lsp" },
    });
  });

  test("opens one hidden warmup anchor and keeps it open for the server", async () => {
    await host.openWarmupDocument(
      "src/main.ts",
      "typescript",
      LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
    );
    await waitFor(() =>
      backend.notifications.some(
        ({ method }) => method === LSP_METHODS.DID_OPEN
      )
    );
    const opened = backend.notifications.filter(
      ({ method }) => method === LSP_METHODS.DID_OPEN
    );
    const params = opened[0].params as {
      textDocument: { uri: string; languageId: string; text: string };
    };
    assert.strictEqual(
      params.textDocument.uri,
      pathToFileURL(path.join(workspaceRoot, "src", "main.ts")).toString()
    );
    assert.strictEqual(params.textDocument.languageId, "typescript");
    assert.strictEqual(params.textDocument.text, "const value = 1;\n");
    await host.openWarmupDocument(
      "src/main.ts",
      "typescript",
      LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
    );
    assert.strictEqual(
      backend.notifications.filter(
        ({ method }) => method === LSP_METHODS.DID_OPEN
      ).length,
      1
    );
  });

  test("claims a warmup URI before concurrent file reads", async () => {
    await Promise.all([
      host.openWarmupDocument(
        "src/main.ts",
        "typescript",
        LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
      ),
      host.openWarmupDocument(
        "src/main.ts",
        "typescript",
        LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
      ),
    ]);
    await waitFor(() =>
      backend.notifications.some(
        ({ method }) => method === LSP_METHODS.DID_OPEN
      )
    );
    await host.dispose();
    await waitFor(() =>
      backend.notifications.some(
        ({ method }) => method === LSP_METHODS.DID_CLOSE
      )
    );
    assert.strictEqual(
      backend.notifications.filter(
        ({ method }) => method === LSP_METHODS.DID_OPEN
      ).length,
      1
    );
    assert.strictEqual(
      backend.notifications.filter(
        ({ method }) => method === LSP_METHODS.DID_CLOSE
      ).length,
      1,
      "a concurrent duplicate must not leave a leaked warmup reference"
    );
  });

  test("resyncs the requesting tab's full text before forwarding its request", async () => {
    await open(proxyA!, "first buffer");
    await open(proxyB!, "second buffer");
    await waitFor(() =>
      backend.events.some(
        ({ isNotification, method }) =>
          isNotification && method === LSP_METHODS.DID_OPEN
      )
    );
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.DID_CHANGE,
      params: {
        textDocument: { uri: viewerUri, version: 2 },
        contentChanges: [{ text: "first buffer changed" }],
      },
    });
    await waitFor(() =>
      backend.events.some(({ isNotification, method, params }) => {
        const changes = (
          params as { contentChanges?: Array<{ text?: string }> }
        ).contentChanges;
        return (
          isNotification &&
          method === LSP_METHODS.DID_CHANGE &&
          changes?.[0]?.text === "first buffer changed"
        );
      })
    );
    const eventOffset = backend.events.length;
    await requestHover(proxyB!, clientB, 2, "second buffer");

    assert.deepStrictEqual(
      backend.events
        .slice(eventOffset)
        .map(({ isNotification, method }) => ({ isNotification, method })),
      [
        { isNotification: true, method: LSP_METHODS.DID_CHANGE },
        { isNotification: false, method: "textDocument/hover" },
      ]
    );
    assert.strictEqual(
      (
        backend.events[eventOffset].params as {
          contentChanges: Array<{ text: string }>;
        }
      ).contentChanges[0].text,
      "second buffer"
    );
    assert.strictEqual(backend.requests.at(-1)?.method, "textDocument/hover");
  });

  test("sends diagnostics only to tabs whose buffer matches the server text", async () => {
    await open(proxyA!, "shared text");
    await open(proxyB!, "shared text");
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.DID_CHANGE,
      params: {
        textDocument: { uri: viewerUri, version: 2 },
        contentChanges: [{ text: "changed in tab A" }],
      },
    });
    await waitFor(() =>
      backend.events.some(({ isNotification, method, params }) => {
        const changes = (
          params as { contentChanges?: Array<{ text?: string }> }
        ).contentChanges;
        return (
          isNotification &&
          method === LSP_METHODS.DID_CHANGE &&
          changes?.[0]?.text === "changed in tab A"
        );
      })
    );
    clientA.length = 0;
    clientB.length = 0;
    await backend.serverConnections[0].sendNotification(
      LSP_METHODS.PUBLISH_DIAGNOSTICS,
      {
        uri: pathToFileURL(
          path.join(workspaceRoot, "src", "main.ts")
        ).toString(),
        diagnostics: [],
      }
    );
    await waitFor(() => clientA.length + clientB.length > 0);

    assert.strictEqual(clientA.length, 1);
    assert.strictEqual(clientB.length, 0);
  });

  test("delivers diagnostics whose URI the server spelled differently", async () => {
    await open(proxyA!, "text");
    clientA.length = 0;
    // typescript-language-server on Windows publishes `file:///c%3A/...` for
    // a document opened as `file:///C:/...`.
    const canonical = pathToFileURL(
      path.join(workspaceRoot, "src", "main.ts")
    ).toString();
    const serverSpelling = canonical.replace(
      /^file:\/\/\/([A-Za-z]):/,
      (_match, drive: string) => `file:///${drive.toLowerCase()}%3A`
    );
    await backend.serverConnections[0].sendNotification(
      LSP_METHODS.PUBLISH_DIAGNOSTICS,
      { uri: serverSpelling, diagnostics: [] }
    );
    await waitFor(() => clientA.length > 0);
    assert.strictEqual(clientA.length, 1);
  });

  test("preserves created, changed, and deleted watched-file event kinds", async () => {
    await open(proxyA!, "text");
    const watchedEvents = () =>
      backend.notifications.filter(
        ({ method }) => method === LSP_METHODS.DID_CHANGE_WATCHED_FILES
      );
    for (const type of [1, 2, 3]) {
      await host.notifyWorkspaceFileChanged("src/main.ts", type);
      await waitFor(() => watchedEvents().length >= type);
    }
    assert.deepStrictEqual(
      watchedEvents().map(
        ({ params }) =>
          (params as { changes: Array<{ type: number }> }).changes[0].type
      ),
      [1, 2, 3]
    );
  });

  test("redacts secret values in server hover responses", async () => {
    const secret = "lsp-super-secret-value";
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ API_KEY: secret });
    releaseRedactor = secretRedactionService.register(redactor);
    backend.requestHandler = () => ({
      contents: { kind: "markdown", value: secret },
    });
    await open(proxyA!, "text");
    await requestHover(proxyA!, clientA, 4, "text");

    assert.ok(
      !JSON.stringify(
        clientA.find((message) => (message as { id?: number }).id === 4)
      ).includes(secret)
    );
  });

  test("rejects inbound file URIs outside every workspace root", async () => {
    const outsideUri = pathToFileURL(
      path.resolve(workspaceRoot, "..", "outside-lsp.ts")
    ).toString();
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: outsideUri },
        position: { line: 0, character: 0 },
      },
    });

    assert.strictEqual(clientA.length, 1);
    assert.ok((clientA[0] as { error?: unknown }).error);
    assert.strictEqual(backend.requests.length, 0);
  });

  test("rejects requests for files the workspace viewer marks read-only", async () => {
    const guardedProxy = await host.createProxy(
      sessionId,
      (message) => clientA.push(message),
      async (viewerPath) => viewerPath !== "src/main.ts"
    );
    await guardedProxy!.handleMessage({
      jsonrpc: "2.0",
      id: 91,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: viewerUri },
        position: { line: 0, character: 0 },
      },
    });
    assert.ok((clientA.at(-1) as { error?: unknown }).error);
    assert.strictEqual(backend.requests.length, 0);
    guardedProxy?.dispose();
  });

  test("turns out-of-root server locations into read-only locations", async () => {
    const outsideUri = pathToFileURL(
      path.resolve(workspaceRoot, "..", "outside-library.d.ts")
    ).toString();
    backend.requestHandler = () => ({ uri: outsideUri });
    await open(proxyA!, "text");
    await requestHover(proxyA!, clientA, 12, "text");
    const result = (
      clientA.find((message) => (message as { id?: number }).id === 12) as {
        result: { uri: string };
      }
    ).result;

    assert.ok(result.uri.startsWith(LSP_READ_ONLY_URI_SCHEME));
    assert.ok(!result.uri.includes(workspaceRoot));
  });

  test("does not didOpen files the hosted viewer marks read-only", async () => {
    const redactedProxy = await host.createProxy(
      sessionId,
      () => undefined,
      async () => false
    );
    await redactedProxy?.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.DID_OPEN,
      params: {
        textDocument: {
          uri: viewerUri,
          languageId: "typescript",
          version: 1,
          text: "[REDACTED]",
        },
      },
    });
    assert.strictEqual(
      backend.notifications.some(
        ({ method }) => method === LSP_METHODS.DID_OPEN
      ),
      false
    );
    redactedProxy?.dispose();
  });

  test("serializes didChange behind an open that is still checking viewer access", async () => {
    let releaseOpen!: () => void;
    let startedOpen!: () => void;
    const openStarted = new Promise<void>((resolve) => (startedOpen = resolve));
    const openAllowed = new Promise<void>((resolve) => (releaseOpen = resolve));
    const orderedProxy = await host.createProxy(
      sessionId,
      () => undefined,
      async () => {
        startedOpen();
        await openAllowed;
        return true;
      }
    );
    const opening = orderedProxy!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.DID_OPEN,
      params: {
        textDocument: {
          uri: viewerUri,
          languageId: "typescript",
          version: 1,
          text: "before",
        },
      },
    });
    await openStarted;
    const changing = orderedProxy!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.DID_CHANGE,
      params: {
        textDocument: { uri: viewerUri, version: 2 },
        contentChanges: [{ text: "after" }],
      },
    });
    assert.strictEqual(
      backend.notifications.some(
        ({ method }) => method === LSP_METHODS.DID_OPEN
      ),
      false
    );
    releaseOpen();
    await Promise.all([opening, changing]);
    await waitFor(
      () =>
        backend.notifications.filter(
          ({ method }) =>
            method === LSP_METHODS.DID_OPEN || method === LSP_METHODS.DID_CHANGE
        ).length === 2
    );
    const documentEvents = backend.notifications.filter(
      ({ method }) =>
        method === LSP_METHODS.DID_OPEN || method === LSP_METHODS.DID_CHANGE
    );
    assert.deepStrictEqual(
      documentEvents.map(({ method }) => method),
      [LSP_METHODS.DID_OPEN, LSP_METHODS.DID_CHANGE]
    );
    assert.strictEqual(
      (documentEvents[1].params as { contentChanges: Array<{ text: string }> })
        .contentChanges[0].text,
      "after"
    );
    orderedProxy?.dispose();
  });

  test("keeps server document versions monotonic when tabs alternate changes", async () => {
    await open(proxyA!, "tab A");
    await open(proxyB!, "tab B");
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.DID_CHANGE,
      params: {
        textDocument: { uri: viewerUri, version: 40 },
        contentChanges: [{ text: "tab A update" }],
      },
    });
    await proxyB!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.DID_CHANGE,
      params: {
        textDocument: { uri: viewerUri, version: 2 },
        contentChanges: [{ text: "tab B update" }],
      },
    });
    await waitFor(
      () =>
        backend.notifications.filter(
          ({ method }) => method === LSP_METHODS.DID_CHANGE
        ).length === 2
    );
    const versions = backend.notifications
      .filter(({ method }) => method === LSP_METHODS.DID_CHANGE)
      .map(
        ({ params }) =>
          (params as { textDocument: { version: number } }).textDocument.version
      );
    assert.deepStrictEqual(versions, [2, 3]);
  });

  test("maps cancellation to the active server request and ignores unknown ids", async () => {
    let finishRequest!: (value: unknown) => void;
    backend.requestHandler = () =>
      new Promise((resolve) => (finishRequest = resolve));
    await open(proxyA!, "text");
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      id: "browser-request",
      method: "textDocument/hover",
      params: { textDocument: { uri: viewerUri } },
    });
    await waitFor(() => backend.requestTokens.length > 0);
    let cancelled = false;
    backend.requestTokens[0].onCancellationRequested(() => (cancelled = true));
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.CANCEL_REQUEST,
      params: { id: "missing" },
    });
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.CANCEL_REQUEST,
      params: { id: "browser-request" },
    });
    await waitFor(() => cancelled);
    finishRequest(null);
  });

  test("applies rename edits to the requesting tab buffer", async () => {
    await open(proxyA!, "const value = 1;\n");
    backend.requestHandler = () => ({
      changes: {
        [pathToFileURL(path.join(workspaceRoot, "src", "main.ts")).toString()]:
          [
            {
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 11 },
              },
              newText: "renamed",
            },
          ],
      },
    });
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      id: 31,
      method: LSP_METHODS.RENAME,
      params: { textDocument: { uri: viewerUri } },
    });
    await waitFor(() =>
      clientA.some(
        (message) =>
          (message as { method?: string }).method ===
          LSP_METHODS.APPLY_WORKSPACE_TEXT_EDITS
      )
    );
    await waitFor(() =>
      clientA.some((message) => (message as { id?: number }).id === 31)
    );
    assert.strictEqual(
      (
        clientA.find((message) => (message as { id?: number }).id === 31) as {
          result: unknown;
        }
      ).result,
      null
    );
    assert.strictEqual(
      backend.notifications.filter(
        ({ method }) => method === LSP_METHODS.DID_CHANGE
      ).length,
      0
    );
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.DID_CHANGE,
      params: {
        textDocument: { uri: viewerUri, version: 2 },
        contentChanges: [{ text: "const renamed = 1;\n" }],
      },
    });
    await waitFor(() =>
      backend.notifications.some(
        ({ method, params }) =>
          method === LSP_METHODS.DID_CHANGE &&
          (params as { contentChanges?: Array<{ text?: string }> })
            .contentChanges?.[0].text === "const renamed = 1;\n"
      )
    );
    assert.strictEqual(
      backend.notifications.filter(
        ({ method }) => method === LSP_METHODS.DID_CHANGE
      ).length,
      1
    );
  });

  test("applies edits to a dirty cross-tab buffer without replacing its unsaved text", async () => {
    await open(proxyA!, "const value = 1;\n");
    await open(proxyB!, "const value = 2; // unsaved\n");
    backend.requestHandler = () => ({
      changes: {
        [pathToFileURL(path.join(workspaceRoot, "src", "main.ts")).toString()]:
          [
            {
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 11 },
              },
              newText: "renamed",
            },
          ],
      },
    });
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      id: 32,
      method: LSP_METHODS.RENAME,
      params: { textDocument: { uri: viewerUri } },
    });
    await waitFor(() =>
      clientB.some(
        (message) =>
          (message as { method?: string }).method ===
          LSP_METHODS.APPLY_WORKSPACE_TEXT_EDITS
      )
    );
    assert.strictEqual(
      clientB.filter(
        (message) =>
          (message as { method?: string }).method ===
          LSP_METHODS.APPLY_WORKSPACE_TEXT_EDITS
      ).length,
      1
    );
    await proxyB!.handleMessage({
      jsonrpc: "2.0",
      method: LSP_METHODS.DID_CHANGE,
      params: {
        textDocument: { uri: viewerUri, version: 2 },
        contentChanges: [{ text: "const renamed = 2; // unsaved\n" }],
      },
    });
    await waitFor(() =>
      backend.notifications.some(
        ({ method, params }) =>
          method === LSP_METHODS.DID_CHANGE &&
          (params as { contentChanges?: Array<{ text?: string }> })
            .contentChanges?.[0].text === "const renamed = 2; // unsaved\n"
      )
    );
  });

  test("confirms and writes edits to unopened files then notifies watched files", async () => {
    const unopened = path.join(workspaceRoot, "src", "other.ts");
    fs.writeFileSync(unopened, "const value = 1;\r\n");
    await host.openWarmupDocument(
      "src/other.ts",
      "typescript",
      LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
    );
    let saved = "";
    const editProxy = await host.createProxy(
      sessionId,
      (message) => clientA.push(message),
      async () => true,
      {
        readFile: async () => ({ content: "const value = 1;\r\n" }),
        writeFile: async (_viewerPath, content) => {
          saved = content;
        },
        notifyFileChanged: async (viewerPath) =>
          host.notifyWorkspaceFileChanged(viewerPath),
      }
    );
    backend.requestHandler = () => ({
      changes: {
        [pathToFileURL(unopened).toString()]: [
          {
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 11 },
            },
            newText: "renamed",
          },
        ],
      },
    });
    const pending = editProxy!.handleMessage({
      jsonrpc: "2.0",
      id: 33,
      method: LSP_METHODS.RENAME,
      params: { textDocument: { uri: viewerUri } },
    });
    await waitFor(() =>
      clientA.some(
        (message) =>
          (message as { method?: string }).method ===
          LSP_METHODS.CONFIRM_WORKSPACE_RENAME
      )
    );
    const confirmation = clientA.find(
      (message) =>
        (message as { method?: string }).method ===
        LSP_METHODS.CONFIRM_WORKSPACE_RENAME
    ) as { id: string };
    await editProxy!.handleMessage({
      jsonrpc: "2.0",
      id: confirmation.id,
      result: true,
    });
    await pending;
    await waitFor(() => saved.length > 0);
    assert.strictEqual(saved, "const renamed = 1;\r\n");
    await waitFor(() =>
      backend.notifications.some(
        ({ method }) => method === LSP_METHODS.DID_CHANGE_WATCHED_FILES
      )
    );
    await waitFor(() =>
      backend.notifications.some(
        ({ method, params }) =>
          method === LSP_METHODS.DID_CHANGE &&
          (params as { contentChanges?: Array<{ text?: string }> })
            .contentChanges?.[0].text === "const renamed = 1;\r\n"
      )
    );
    assert.ok(
      backend.notifications.some(
        ({ method, params }) =>
          method === LSP_METHODS.DID_CHANGE_WATCHED_FILES &&
          (params as { changes?: unknown[] }).changes?.length === 1
      )
    );
    editProxy?.dispose();
  });

  test("rejects a workspace edit targeting a redacted file", async () => {
    const secretPath = path.join(workspaceRoot, "src", "secret.ts");
    fs.writeFileSync(secretPath, "const secret = true;\n");
    const writes: string[] = [];
    const readOnlyProxy = await host.createProxy(
      sessionId,
      (message) => clientA.push(message),
      async (p) => p !== "src/secret.ts",
      {
        readFile: async () => ({ content: "[REDACTED]", readOnly: true }),
        writeFile: async (viewerPath) => {
          writes.push(viewerPath);
        },
        notifyFileChanged: async () => undefined,
      }
    );
    backend.requestHandler = () => ({
      changes: {
        [pathToFileURL(secretPath).toString()]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "changed",
          },
        ],
      },
    });
    await readOnlyProxy!.handleMessage({
      jsonrpc: "2.0",
      id: 34,
      method: LSP_METHODS.RENAME,
      params: { textDocument: { uri: viewerUri } },
    });
    await waitFor(() =>
      clientA.some((message) => (message as { id?: number }).id === 34)
    );
    assert.deepStrictEqual(writes, []);
    assert.ok(
      (
        clientA.find((message) => (message as { id?: number }).id === 34) as {
          error?: unknown;
        }
      ).error
    );
    readOnlyProxy?.dispose();
  });
});

const viewerUri = `${LSP_VIEWER_URI_PREFIX}src/main.ts`;

async function open(
  proxy: NonNullable<
    Awaited<ReturnType<LanguageIntelligenceHost["createProxy"]>>
  >,
  text: string
): Promise<void> {
  await proxy.handleMessage({
    jsonrpc: "2.0",
    method: LSP_METHODS.DID_OPEN,
    params: {
      textDocument: {
        uri: viewerUri,
        languageId: "typescript",
        version: 1,
        text,
      },
    },
  });
}

async function requestHover(
  proxy: NonNullable<
    Awaited<ReturnType<LanguageIntelligenceHost["createProxy"]>>
  >,
  messages: unknown[],
  id: number,
  marker: string
): Promise<void> {
  await proxy.handleMessage({
    jsonrpc: "2.0",
    id,
    method: "textDocument/hover",
    params: {
      marker,
      textDocument: { uri: viewerUri },
      position: { line: 0, character: 0 },
    },
  });
  await waitFor(() =>
    messages.some((message) => (message as { id?: number }).id === id)
  );
}

function flushMessages(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for fake LSP traffic");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
