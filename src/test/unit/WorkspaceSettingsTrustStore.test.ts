import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { WorkspaceSettingsTrustStore } from "../../config/WorkspaceSettingsTrustStore";
import type { WorkspaceSensitiveSettingRequest } from "../../config/WorkspaceSensitiveSettings";
import { TRUST_DECISIONS } from "../../types/DashboardConstants";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

function request(fingerprint: string): WorkspaceSensitiveSettingRequest {
  return {
    settingPath: "terminal.shellExecutable",
    fingerprint,
    summary: `terminal.shellExecutable: ${fingerprint}`,
  };
}

suite("WorkspaceSettingsTrustStore", () => {
  let tempDir: string;
  let storePath: string;
  let store: WorkspaceSettingsTrustStore;

  setup(() => {
    tempDir = makeTempDir("ctrlyoke-workspace-settings-trust-");
    storePath = path.join(tempDir, "workspace-settings-trust.json");
    store = new WorkspaceSettingsTrustStore(storePath);
  });

  teardown(() => {
    removeTempDir(tempDir);
  });

  test("an unknown value is undecided", () => {
    assert.strictEqual(store.getDecision("ws", request("a")), undefined);
  });

  test("records decisions per workspace and per exact value", async () => {
    await store.setDecisions("ws", [request("a")], TRUST_DECISIONS.ALLOW);
    await store.setDecisions("ws", [request("b")], TRUST_DECISIONS.DENY);

    assert.strictEqual(store.getDecision("ws", request("a")), "allow");
    assert.strictEqual(store.getDecision("ws", request("b")), "deny");
    assert.strictEqual(store.getDecision("other", request("a")), undefined);
    assert.strictEqual(store.getDecision("ws", request("c")), undefined);
  });

  test("sees decisions written by another process", async () => {
    assert.strictEqual(store.getDecision("ws", request("a")), undefined);
    const otherProcess = new WorkspaceSettingsTrustStore(storePath);
    await otherProcess.setDecisions("ws", [request("a")], "allow");
    // Force a distinct mtime in case the filesystem's resolution is coarse.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(storePath, later, later);

    assert.strictEqual(store.getDecision("ws", request("a")), "allow");
  });

  test("an unparseable store withholds everything and refuses to overwrite it", async () => {
    fs.writeFileSync(storePath, "{ not json");
    assert.strictEqual(store.getDecision("ws", request("a")), undefined);
    await assert.rejects(
      store.setDecisions("ws", [request("a")], "allow"),
      /invalid JSON/
    );
    assert.strictEqual(fs.readFileSync(storePath, "utf8"), "{ not json");
  });

  test("reports each undecided value to listeners once, asynchronously", async () => {
    const heard: string[] = [];
    const unsubscribe = store.onUndecided((identity) => heard.push(identity));

    store.reportUndecided("ws", [request("a")]);
    assert.deepStrictEqual(heard, [], "listeners must not run inside a read");
    await Promise.resolve();
    assert.deepStrictEqual(heard, ["ws"]);

    store.reportUndecided("ws", [request("a")]);
    await Promise.resolve();
    assert.deepStrictEqual(heard, ["ws"], "the same value is not re-reported");

    unsubscribe();
    store.reportUndecided("ws", [request("b")]);
    await Promise.resolve();
    assert.deepStrictEqual(heard, ["ws"]);
  });
});
