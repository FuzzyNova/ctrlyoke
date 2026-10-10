import * as assert from "assert";
import * as path from "path";
import { suite, test } from "mocha";
import { evaluateFileAccess } from "../../utils/FileAccessPolicy";

suite("FileAccessPolicy", () => {
  const workspaceRoot = path.resolve("/repos/frontend");
  const externalRoot = path.resolve("/var/log/my-tool");

  test("allows a path inside the workspace", () => {
    const decision = evaluateFileAccess(
      path.join(workspaceRoot, "src", "a.ts"),
      { workspaceRoots: [workspaceRoot], approvedExternalRoots: [] }
    );
    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.reason, "workspace");
    assert.strictEqual(decision.matchedRoot, workspaceRoot);
  });

  test("allows a path inside an approved external root", () => {
    const decision = evaluateFileAccess(path.join(externalRoot, "debug.log"), {
      workspaceRoots: [workspaceRoot],
      approvedExternalRoots: [externalRoot],
    });
    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.reason, "trustedExternalRoot");
    assert.strictEqual(decision.matchedRoot, externalRoot);
  });

  test("resolves approved external roots containing a parent segment", () => {
    const rootWithParentSegment = `${path.dirname(externalRoot)}${path.sep}unused${path.sep}..${path.sep}${path.basename(externalRoot)}`;
    const decision = evaluateFileAccess(path.join(externalRoot, "debug.log"), {
      workspaceRoots: [workspaceRoot],
      approvedExternalRoots: [rootWithParentSegment],
    });

    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.reason, "trustedExternalRoot");
    assert.strictEqual(decision.matchedRoot, externalRoot);
  });

  test("allows the external root itself when its spelling has a trailing separator", () => {
    const rootWithTrailingSeparator = `${externalRoot}${path.sep}`;
    const decision = evaluateFileAccess(externalRoot, {
      workspaceRoots: [workspaceRoot],
      approvedExternalRoots: [rootWithTrailingSeparator],
    });

    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.reason, "trustedExternalRoot");
    assert.strictEqual(decision.matchedRoot, externalRoot);
  });

  if (process.platform === "win32") {
    test("resolves a forward-slash Windows external root", () => {
      const candidate = "C:\\Users\\natha\\shared\\a.md";
      const decision = evaluateFileAccess(candidate, {
        workspaceRoots: ["C:\\dev\\ws"],
        approvedExternalRoots: ["C:/Users/natha/shared"],
      });

      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(decision.reason, "trustedExternalRoot");
      assert.strictEqual(
        decision.matchedRoot,
        path.resolve("C:/Users/natha/shared")
      );
    });

    test("does not widen a normalized Windows root to a sibling prefix", () => {
      const decision = evaluateFileAccess(
        "C:\\Users\\natha\\shared-evil\\a.md",
        {
          workspaceRoots: ["C:\\dev\\ws"],
          approvedExternalRoots: ["C:/Users/natha/shared"],
        }
      );

      assert.strictEqual(decision.allowed, false);
      assert.strictEqual(decision.reason, "outsideTrustedRoots");
    });
  }

  test("allows a UI read inside its own state root without trusting that root as workspace", () => {
    const ownStateRoot = path.resolve(
      "/home/tester/.ctrlyoke/projects/frontend"
    );
    const candidate = path.join(
      ownStateRoot,
      ".runs",
      "workflow",
      "manifest.json"
    );
    const decision = evaluateFileAccess(candidate, {
      workspaceRoots: [workspaceRoot],
      ownStateRoots: [ownStateRoot],
      approvedExternalRoots: [],
    });
    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.reason, "ownStateRoot");
    assert.strictEqual(decision.matchedRoot, ownStateRoot);

    const harnessDecision = evaluateFileAccess(candidate, {
      workspaceRoots: [workspaceRoot],
      approvedExternalRoots: [],
    });
    assert.strictEqual(harnessDecision.allowed, false);
    assert.strictEqual(harnessDecision.reason, "outsideTrustedRoots");
  });

  test("blocks a path outside every trusted root", () => {
    const decision = evaluateFileAccess(path.resolve("/etc/passwd"), {
      workspaceRoots: [workspaceRoot],
      approvedExternalRoots: [externalRoot],
    });
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, "outsideTrustedRoots");
    assert.strictEqual(decision.matchedRoot, undefined);
  });

  test("rejects a sibling-prefix path against a trusted external root", () => {
    const sibling = path.resolve("/var/log/my-tool-evil/payload.log");
    const decision = evaluateFileAccess(sibling, {
      workspaceRoots: [workspaceRoot],
      approvedExternalRoots: [externalRoot],
    });
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, "outsideTrustedRoots");
  });

  test("an unapproved external root is not trusted (pending/denied roots must not be passed in)", () => {
    const unapprovedRoot = path.resolve("/var/log/other-tool");
    const decision = evaluateFileAccess(
      path.join(unapprovedRoot, "debug.log"),
      { workspaceRoots: [workspaceRoot], approvedExternalRoots: [externalRoot] }
    );
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, "outsideTrustedRoots");
  });

  suite("Windows case-insensitive matching", () => {
    test("matches a differently-cased candidate against a trusted root on win32", () => {
      const decision = evaluateFileAccess("C:\\Dev\\Project\\src\\a.ts", {
        workspaceRoots: ["c:\\dev\\project"],
        approvedExternalRoots: [],
        pathImplementation: path.win32,
        platform: "win32",
      });
      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(decision.reason, "workspace");
    });

    test("still rejects a sibling-prefix path on win32 regardless of casing", () => {
      const decision = evaluateFileAccess(
        "C:\\Dev\\Project-Evil\\payload.ps1",
        {
          workspaceRoots: ["c:\\dev\\project"],
          approvedExternalRoots: [],
          pathImplementation: path.win32,
          platform: "win32",
        }
      );
      assert.strictEqual(decision.allowed, false);
    });

    test("is case-sensitive on non-Windows platforms", () => {
      const decision = evaluateFileAccess("/Dev/Project/src/a.ts", {
        workspaceRoots: ["/dev/project"],
        approvedExternalRoots: [],
        pathImplementation: path.posix,
        platform: "linux",
      });
      assert.strictEqual(decision.allowed, false);
    });
  });
});
