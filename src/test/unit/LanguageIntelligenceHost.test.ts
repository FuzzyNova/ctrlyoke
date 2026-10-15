import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { LanguageIntelligenceHost } from "../../server/lsp/LanguageIntelligenceHost";
import {
  LANGUAGE_SERVER_REQUEST_ORIGINS,
  LSP_SESSION_INVALIDATION_CLOSE,
  LSP_SESSION_LOOKUP_REASONS,
} from "../../types/DashboardConstants";
import { InMemoryLanguageServerBackend } from "../helpers/InMemoryLanguageServerBackend";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("LanguageIntelligenceHost ctrlyoke-file exclusion", () => {
  let workspaceRoot: string;
  let backend: InMemoryLanguageServerBackend;
  let host: LanguageIntelligenceHost;

  const ORIGIN = LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR;
  const CTRLYOKE_FILES = [
    "flow.ctrlyoke.yaml",
    "flow.ctrlyoke.yml",
    "flow.ctrlyoke.json",
    "intro.prompt.md",
  ];
  const PLAIN_FILES = ["plain.yaml", "plain.json", "README.md"];

  setup(() => {
    workspaceRoot = makeTempDir("ctrlyoke-lsp-exclusion-");
    for (const name of [...CTRLYOKE_FILES, ...PLAIN_FILES]) {
      fs.writeFileSync(path.join(workspaceRoot, name), "key: value\n");
    }
    backend = new InMemoryLanguageServerBackend(workspaceRoot, "yaml");
    host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
  });

  teardown(async () => {
    await host.dispose();
    removeTempDir(workspaceRoot);
  });

  test("reports no session for ctrlyoke files, even when a server would match", async () => {
    for (const name of CTRLYOKE_FILES) {
      const lookup = await host.lookupSession(name, ORIGIN);
      assert.strictEqual(lookup.session, null, name);
      assert.strictEqual(
        lookup.reason,
        LSP_SESSION_LOOKUP_REASONS.CTRLYOKE_FILE,
        name
      );
    }
  });

  test("still resolves plain YAML, JSON and Markdown files", async () => {
    for (const name of PLAIN_FILES) {
      const lookup = await host.lookupSession(name, ORIGIN);
      assert.ok(lookup.session, name);
      assert.strictEqual(lookup.reason, undefined, name);
    }
  });

  test("never resolves or requests through a server for a ctrlyoke file", async () => {
    assert.strictEqual(
      await host.resolveForPath("flow.ctrlyoke.yaml", ORIGIN),
      undefined
    );
    assert.strictEqual(
      await host.requestForPath("flow.ctrlyoke.yaml", "any/method", {}, ORIGIN),
      undefined
    );
    await host.openWarmupDocument("flow.ctrlyoke.yaml", "yaml", ORIGIN);
    assert.deepStrictEqual(backend.notifications, []);
    assert.deepStrictEqual(backend.requests, []);
  });

  test("invalidates active proxies when the host is disposed", async () => {
    const lookup = await host.lookupSession("plain.ts", ORIGIN);
    assert.ok(lookup.session);
    let invalidation: { code: number; reason: string } | undefined;
    const proxy = await host.createProxy(
      lookup.session.id,
      () => undefined,
      async () => true,
      undefined,
      (code, reason) => {
        invalidation = { code, reason };
      }
    );
    assert.ok(proxy);

    await host.dispose();

    assert.deepStrictEqual(invalidation, {
      code: LSP_SESSION_INVALIDATION_CLOSE.CODE,
      reason: LSP_SESSION_INVALIDATION_CLOSE.REASON,
    });
  });
});
