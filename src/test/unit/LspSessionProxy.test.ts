import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";
import { suite, test } from "mocha";
import { LanguageIntelligenceHost } from "../../server/lsp/LanguageIntelligenceHost";
import { LSP_METHODS } from "../../types/DashboardConstants";
import {
  LSP_READ_ONLY_URI_SCHEME,
  LSP_VIEWER_URI_PREFIX,
} from "../../server/lsp/LspProtocol";
import { RunSecretRedactor, secretRedactionService } from "../../utils/SecretRedactionService";
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
    fs.writeFileSync(path.join(workspaceRoot, "src", "main.ts"), "const value = 1;\n");
    backend = new InMemoryLanguageServerBackend(workspaceRoot);
    host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    clientA = [];
    clientB = [];
    const lookup = await host.lookupSession("src/main.ts");
    assert.ok(lookup.session);
    sessionId = lookup.session.id;
    proxyA = await host.createProxy(sessionId, (message) => clientA.push(message), async () => true);
    proxyB = await host.createProxy(sessionId, (message) => clientB.push(message), async () => true);
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
    await requestHover(proxyA!, 1, "client-a");
    await requestHover(proxyB!, 1, "client-b");

    assert.ok(backend.requests.length >= 2, `requests=${JSON.stringify(backend.requests)}`);
    assert.strictEqual((clientA[0] as { id: number }).id, 1);
    assert.strictEqual((clientB[0] as { id: number }).id, 1);
    assert.deepStrictEqual((clientA[0] as { result: unknown }).result, { marker: "client-a" });
    assert.deepStrictEqual((clientB[0] as { result: unknown }).result, { marker: "client-b" });
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
        const changes = (params as { contentChanges?: Array<{ text?: string }> })
          .contentChanges;
        return (
          isNotification &&
          method === LSP_METHODS.DID_CHANGE &&
          changes?.[0]?.text === "first buffer changed"
        );
      })
    );
    const eventOffset = backend.events.length;
    await requestHover(proxyB!, 2, "second buffer");

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
      (backend.events[eventOffset].params as { contentChanges: Array<{ text: string }> })
        .contentChanges[0].text,
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
    clientA.length = 0;
    clientB.length = 0;
    await backend.serverConnections[0].sendNotification(
      LSP_METHODS.PUBLISH_DIAGNOSTICS,
      { uri: pathToFileURL(path.join(workspaceRoot, "src", "main.ts")).toString(), diagnostics: [] }
    );
    await flushMessages();

    assert.strictEqual(clientA.length, 1);
    assert.strictEqual(clientB.length, 0);
  });

  test("redacts secret values in server hover responses", async () => {
    const secret = "lsp-super-secret-value";
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ API_KEY: secret });
    releaseRedactor = secretRedactionService.register(redactor);
    backend.requestHandler = () => ({ contents: { kind: "markdown", value: secret } });
    await open(proxyA!, "text");
    await requestHover(proxyA!, 4, "text");

    assert.ok(!JSON.stringify(clientA[0]).includes(secret));
  });

  test("rejects inbound file URIs outside every workspace root", async () => {
    const outsideUri = pathToFileURL(
      path.resolve(workspaceRoot, "..", "outside-lsp.ts")
    ).toString();
    await proxyA!.handleMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "textDocument/hover",
      params: { textDocument: { uri: outsideUri }, position: { line: 0, character: 0 } },
    });

    assert.strictEqual(clientA.length, 1);
    assert.ok((clientA[0] as { error?: unknown }).error);
    assert.strictEqual(backend.requests.length, 0);
  });

  test("turns out-of-root server locations into read-only locations", async () => {
    const outsideUri = pathToFileURL(
      path.resolve(workspaceRoot, "..", "outside-library.d.ts")
    ).toString();
    backend.requestHandler = () => ({ uri: outsideUri });
    await open(proxyA!, "text");
    await requestHover(proxyA!, 12, "text");
    const result = (clientA[0] as { result: { uri: string } }).result;

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
      backend.notifications.some(({ method }) => method === LSP_METHODS.DID_OPEN),
      false
    );
    redactedProxy?.dispose();
  });
});

const viewerUri = `${LSP_VIEWER_URI_PREFIX}src/main.ts`;

async function open(
  proxy: NonNullable<Awaited<ReturnType<LanguageIntelligenceHost["createProxy"]>>>,
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
  proxy: NonNullable<Awaited<ReturnType<LanguageIntelligenceHost["createProxy"]>>>,
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
}

function flushMessages(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fake LSP traffic");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
