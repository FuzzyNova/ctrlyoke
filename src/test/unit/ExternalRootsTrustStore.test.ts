import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("ExternalRootsTrustStore", () => {
  let tempDir: string;
  let storePath: string;
  let store: ExternalRootsTrustStore;
  const createdRoots: string[] = [];

  setup(() => {
    tempDir = makeTempDir("ctrlyoke-trust-store-");
    storePath = path.join(tempDir, "external-roots-trust.json");
    store = new ExternalRootsTrustStore(storePath);
  });

  teardown(() => {
    removeTempDir(tempDir);
    for (const root of createdRoots.splice(0)) {
      removeTempDir(root);
    }
  });

  const workspaceA = "workspace-a";
  const workspaceB = "workspace-b";
  const rootDir = () => {
    const dir = makeTempDir("ctrlyoke-external-root-");
    createdRoots.push(dir);
    return dir;
  };

  test("getDecision returns undefined for a never-decided root", () => {
    const root = rootDir();
    assert.strictEqual(store.getDecision(workspaceA, root), undefined);
  });

  test("setDecisions records a batch allow decision", async () => {
    const rootOne = rootDir();
    const rootTwo = rootDir();
    await store.setDecisions(workspaceA, [rootOne, rootTwo], "allow");

    assert.strictEqual(store.getDecision(workspaceA, rootOne), "allow");
    assert.strictEqual(store.getDecision(workspaceA, rootTwo), "allow");
  });

  test("getApprovedRoots only returns allowed roots", async () => {
    const allowed = rootDir();
    const denied = rootDir();
    const pending = rootDir();
    await store.setDecisions(workspaceA, [allowed], "allow");
    await store.setDecisions(workspaceA, [denied], "deny");

    const approved = store.getApprovedRoots(workspaceA, [
      allowed,
      denied,
      pending,
    ]);
    assert.deepStrictEqual(approved, [allowed]);
  });

  test("getPendingRoots excludes both allowed and denied roots", async () => {
    const allowed = rootDir();
    const denied = rootDir();
    const pending = rootDir();
    await store.setDecisions(workspaceA, [allowed], "allow");
    await store.setDecisions(workspaceA, [denied], "deny");

    const pendingRoots = store.getPendingRoots(workspaceA, [
      allowed,
      denied,
      pending,
    ]);
    assert.deepStrictEqual(pendingRoots, [pending]);
  });

  test("decisions are isolated per workspace identity", async () => {
    const root = rootDir();
    await store.setDecisions(workspaceA, [root], "allow");

    assert.strictEqual(store.getDecision(workspaceA, root), "allow");
    assert.strictEqual(store.getDecision(workspaceB, root), undefined);
  });

  test("workflow identities do not collide with workspace identities", async () => {
    const root = rootDir();
    const workflowIdentity =
      ExternalRootsTrustStore.canonicalizeWorkflowIdentity(root, root);
    const workspaceIdentity = ExternalRootsTrustStore.canonicalizeRoot(root);

    await store.setDecisions(workspaceIdentity, [root], "allow");
    assert.strictEqual(store.getDecision(workspaceIdentity, root), "allow");
    assert.strictEqual(store.getDecision(workflowIdentity, root), undefined);

    await store.setDecisions(workflowIdentity, [root], "deny");
    assert.strictEqual(store.getDecision(workflowIdentity, root), "deny");
    assert.strictEqual(store.getDecision(workspaceIdentity, root), "allow");
  });

  test("a denied root stays denied and is never reported as pending again", async () => {
    const root = rootDir();
    await store.setDecisions(workspaceA, [root], "deny");

    assert.strictEqual(store.getDecision(workspaceA, root), "deny");
    assert.deepStrictEqual(store.getPendingRoots(workspaceA, [root]), []);
  });

  test("survives a corrupt store file by treating it as empty", () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "{ not valid json", "utf-8");
    const root = rootDir();
    assert.strictEqual(store.getDecision(workspaceA, root), undefined);
  });

  test("canonicalizeRoot resolves a nonexistent path lexically without throwing", () => {
    const nonexistent = path.join(tempDir, "does-not-exist-yet");
    const canonical = ExternalRootsTrustStore.canonicalizeRoot(nonexistent);
    assert.strictEqual(canonical, path.resolve(nonexistent));
  });
});
