import * as assert from "assert";
import * as path from "path";
import { suite, test } from "mocha";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";
import { promptBatchApprovalForPendingRoots } from "../../ui/ExternalRootsApproval";
import type { UserInteractionPort } from "../../ui/UserInteractionPort";
import { evaluateFileAccess } from "../../utils/FileAccessPolicy";

suite("ExternalRootsApproval — workspace state root", () => {
  test("declining an outside state root records no access grant", async () => {
    const workspaceIdentity = path.resolve("/repos/project-state");
    const outsideRoot = path.resolve("/home/user");
    const decisions = new Map<string, "allow" | "deny">();
    const keyFor = (identity: string, root: string) =>
      `${identity}::${ExternalRootsTrustStore.canonicalizeRoot(root)}`;
    const store = {
      getApprovedRoots: (identity: string, roots: readonly string[]) =>
        roots.filter(
          (root) => decisions.get(keyFor(identity, root)) === "allow"
        ),
      getPendingRoots: (identity: string, roots: readonly string[]) =>
        roots.filter((root) => !decisions.has(keyFor(identity, root))),
      setDecisions: async (
        identity: string,
        roots: readonly string[],
        decision: "allow" | "deny"
      ) => {
        for (const root of roots)
          decisions.set(keyFor(identity, root), decision);
      },
    };
    const port: UserInteractionPort = {
      canPrompt: () => true,
      requestChoice: async () => undefined,
      requestBatchApproval: async (request) => ({
        approvedValues: [],
        deniedValues: request.items.map((item) => item.value),
      }),
    };

    await promptBatchApprovalForPendingRoots(
      workspaceIdentity,
      [outsideRoot],
      "Workspace requests an external root",
      port,
      store
    );

    const approvedRoots = store.getApprovedRoots(workspaceIdentity, [
      outsideRoot,
    ]);
    const decision = evaluateFileAccess(
      path.join(outsideRoot, ".ssh", "config"),
      {
        workspaceRoots: [path.resolve("/repos/project")],
        approvedExternalRoots: approvedRoots,
      }
    );
    assert.strictEqual(
      decisions.get(keyFor(workspaceIdentity, outsideRoot)),
      "deny"
    );
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, "outsideTrustedRoots");
  });
});
