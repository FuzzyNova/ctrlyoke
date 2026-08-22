import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";
import { SecretGrantsTrustStore } from "../../config/SecretGrantsTrustStore";

suite("SecretGrantsTrustStore", () => {
  let tempDir: string;
  let storePath: string;
  let store: SecretGrantsTrustStore;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-secret-trust-"));
    storePath = path.join(tempDir, "secret-grants-trust.json");
    store = new SecretGrantsTrustStore(storePath);
  });

  teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const workspaceA = "workspace-a";
  const workspaceB = "workspace-b";

  test("getDecision returns undefined for a never-decided grant", () => {
    assert.strictEqual(store.getDecision(workspaceA, "API_TOKEN"), undefined);
  });

  test("setDecisions records allow and deny decisions", async () => {
    await store.setDecisions(workspaceA, ["ALLOWED_TOKEN"], "allow");
    await store.setDecisions(workspaceA, ["DENIED_TOKEN"], "deny");

    assert.strictEqual(store.getDecision(workspaceA, "ALLOWED_TOKEN"), "allow");
    assert.strictEqual(store.getDecision(workspaceA, "DENIED_TOKEN"), "deny");
  });

  test("getApprovedGrants only returns allowed names", async () => {
    await store.setDecisions(workspaceA, ["ALLOWED_TOKEN"], "allow");
    await store.setDecisions(workspaceA, ["DENIED_TOKEN"], "deny");

    assert.deepStrictEqual(
      store.getApprovedGrants(workspaceA, [
        "ALLOWED_TOKEN",
        "DENIED_TOKEN",
        "PENDING_TOKEN",
      ]),
      ["ALLOWED_TOKEN"]
    );
  });

  test("getPendingGrants excludes both allowed and denied names", async () => {
    await store.setDecisions(workspaceA, ["ALLOWED_TOKEN"], "allow");
    await store.setDecisions(workspaceA, ["DENIED_TOKEN"], "deny");

    assert.deepStrictEqual(
      store.getPendingGrants(workspaceA, [
        "ALLOWED_TOKEN",
        "DENIED_TOKEN",
        "PENDING_TOKEN",
      ]),
      ["PENDING_TOKEN"]
    );
  });

  test("decisions are isolated per workspace identity", async () => {
    await store.setDecisions(workspaceA, ["API_TOKEN"], "allow");

    assert.strictEqual(store.getDecision(workspaceA, "API_TOKEN"), "allow");
    assert.strictEqual(store.getDecision(workspaceB, "API_TOKEN"), undefined);
  });

  test("decisions persist and use the exact separator key", async () => {
    await store.setDecisions(workspaceA, ["API_TOKEN"], "allow");

    const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8")) as {
      decisions: Record<string, string>;
    };
    const expectedKey = `${ExternalRootsTrustStore.canonicalizeRoot(
      workspaceA
    )}␟API_TOKEN`;

    assert.strictEqual(persisted.decisions[expectedKey], "allow");
    assert.strictEqual(
      new SecretGrantsTrustStore(storePath).getDecision(
        workspaceA,
        "API_TOKEN"
      ),
      "allow"
    );
  });

  test("survives a corrupt store file by treating it as empty", () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "{ not valid json", "utf-8");

    assert.strictEqual(store.getDecision(workspaceA, "API_TOKEN"), undefined);
  });
});
