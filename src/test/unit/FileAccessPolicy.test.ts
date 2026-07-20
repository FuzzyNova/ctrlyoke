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
    const originalPlatform = process.platform;

    function setPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, "platform", { value: platform });
    }

    teardown(() => {
      setPlatform(originalPlatform);
    });

    test("matches a differently-cased candidate against a trusted root on win32", () => {
      setPlatform("win32");
      const decision = evaluateFileAccess("C:\\Dev\\Project\\src\\a.ts", {
        workspaceRoots: ["c:\\dev\\project"],
        approvedExternalRoots: [],
      });
      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(decision.reason, "workspace");
    });

    test("still rejects a sibling-prefix path on win32 regardless of casing", () => {
      setPlatform("win32");
      const decision = evaluateFileAccess(
        "C:\\Dev\\Project-Evil\\payload.ps1",
        {
          workspaceRoots: ["c:\\dev\\project"],
          approvedExternalRoots: [],
        }
      );
      assert.strictEqual(decision.allowed, false);
    });

    test("is case-sensitive on non-Windows platforms", () => {
      setPlatform("linux");
      const decision = evaluateFileAccess("/Dev/Project/src/a.ts", {
        workspaceRoots: ["/dev/project"],
        approvedExternalRoots: [],
      });
      assert.strictEqual(decision.allowed, false);
    });
  });
});
