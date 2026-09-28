import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";
import { foldPathForCompare } from "../../utils/PathCasing";
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

  test("preserves decisions in BOM and trailing-comma JSONC files", async () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const rootA = path.join(tempDir, "root-a");
    const rootB = path.join(tempDir, "root-b");
    const rootC = path.join(tempDir, "root-c");
    const key = (root: string) =>
      `${workspaceA}␟${ExternalRootsTrustStore.canonicalizeRoot(root)}`;
    fs.writeFileSync(
      storePath,
      `\uFEFF${JSON.stringify({
        decisions: { [key(rootA)]: "deny", [key(rootB)]: "allow" },
      }).replace("}}", ",}}")}`,
      "utf-8"
    );

    await store.setDecisions(workspaceA, [rootC], "allow");

    const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8")) as {
      decisions: Record<string, string>;
    };
    assert.deepStrictEqual(persisted.decisions, {
      [key(rootA)]: "deny",
      [key(rootB)]: "allow",
      [key(rootC)]: "allow",
    });
  });

  test("refuses to overwrite an unparseable store file", async () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const original = "{ not valid json";
    fs.writeFileSync(storePath, original, "utf-8");

    await assert.rejects(
      store.setDecisions(workspaceA, [rootDir()], "allow"),
      /contains invalid JSON/
    );
    assert.strictEqual(fs.readFileSync(storePath, "utf-8"), original);
  });

  test("serializes concurrent decisions and leaves valid JSON", async () => {
    const rootA = path.join(tempDir, "parallel-a");
    const rootB = path.join(tempDir, "parallel-b");
    const results = await Promise.allSettled([
      store.setDecisions("workspace-a", [rootA], "allow"),
      store.setDecisions("workflow-b", [rootB], "deny"),
    ]);

    assert.deepStrictEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"]
    );
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8")) as {
      decisions: Record<string, string>;
    };
    assert.strictEqual(
      persisted.decisions[
        `workspace-a␟${ExternalRootsTrustStore.canonicalizeRoot(rootA)}`
      ],
      "allow"
    );
    assert.strictEqual(
      persisted.decisions[
        `workflow-b␟${ExternalRootsTrustStore.canonicalizeRoot(rootB)}`
      ],
      "deny"
    );
  });

  test("canonicalizeRoot uses the nearest existing ancestor for a missing path", () => {
    const nonexistent = path.join(tempDir, "does-not-exist-yet");
    const canonical = ExternalRootsTrustStore.canonicalizeRoot(nonexistent);
    assert.strictEqual(
      canonical,
      foldPathForCompare(
        path.join(fs.realpathSync.native(tempDir), path.basename(nonexistent))
      )
    );
  });

  test("a decision recorded before a root is created remains approved", async () => {
    const root = path.join(tempDir, "created-later");
    await store.setDecisions(workspaceA, [root], "allow");
    assert.deepStrictEqual(store.getApprovedRoots(workspaceA, [root]), [root]);

    fs.mkdirSync(root);

    assert.deepStrictEqual(store.getApprovedRoots(workspaceA, [root]), [root]);
    assert.deepStrictEqual(store.getPendingRoots(workspaceA, [root]), []);
  });

  test("differently-cased roots match on Windows", async () => {
    const root = rootDir();
    const differentlyCasedRoot = root.replace(/[a-z]/gi, (letter) =>
      letter === letter.toLowerCase()
        ? letter.toUpperCase()
        : letter.toLowerCase()
    );
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform"
    );

    try {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });
      await store.setDecisions(workspaceA, [root], "allow");
      assert.strictEqual(
        store.getDecision(workspaceA, differentlyCasedRoot),
        "allow"
      );
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});
