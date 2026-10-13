import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { parseDocument } from "yaml";
import { afterEach, suite, test } from "mocha";
import {
  confirmExternalFileTrust,
  type ExternalFileTrustContext,
} from "../../ui/ExternalRootsApproval";
import type {
  ChoiceRequest,
  UserInteractionPort,
} from "../../ui/UserInteractionPort";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import {
  EXTERNAL_FILE_TRUST_SCOPES,
  TRUST_DECISIONS,
} from "../../types/DashboardConstants";
import type {
  ExternalRootTrustDecision,
  ExternalRootsTrustStore,
} from "../../config/ExternalRootsTrustStore";

class FakeInteractionPort implements UserInteractionPort {
  constructor(private readonly choice: string | undefined) {}

  canPrompt(): boolean {
    return true;
  }

  async requestBatchApproval(): Promise<undefined> {
    return undefined;
  }

  async requestChoice(request: ChoiceRequest): Promise<string | undefined> {
    this.lastRequest = request;
    return this.choice;
  }

  lastRequest: ChoiceRequest | undefined;
}

class RecordingTrustStore implements Pick<
  ExternalRootsTrustStore,
  "setDecisions"
> {
  readonly decisions: Array<{
    scopeIdentity: string;
    roots: readonly string[];
    decision: ExternalRootTrustDecision;
  }> = [];

  async setDecisions(
    scopeIdentity: string,
    roots: readonly string[],
    decision: ExternalRootTrustDecision
  ): Promise<void> {
    this.decisions.push({ scopeIdentity, roots, decision });
  }
}

suite("ExternalFileTrustPrompt", () => {
  const originalShouldOffer =
    ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks;
  const originalAddUser = ConfigurationUtils.addUserAllowedExternalFileRoot;
  const originalAddWorkspace =
    ConfigurationUtils.addWorkspaceAllowedExternalFileRoot;
  const originalEffective =
    ConfigurationUtils.getEffectiveApprovedExternalFileRoots;
  const tempPaths: string[] = [];

  afterEach(async () => {
    ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks =
      originalShouldOffer;
    ConfigurationUtils.addUserAllowedExternalFileRoot = originalAddUser;
    ConfigurationUtils.addWorkspaceAllowedExternalFileRoot =
      originalAddWorkspace;
    ConfigurationUtils.getEffectiveApprovedExternalFileRoots =
      originalEffective;
    for (const tempPath of tempPaths.splice(0)) {
      await fs.rm(tempPath, { recursive: true, force: true });
    }
  });

  function context(
    port: UserInteractionPort,
    workspaceRoot?: string,
    workflowSourcePath?: string,
    trustStore?: RecordingTrustStore,
    onWorkflowRootsUpdated?: (roots: string[]) => Promise<void>
  ): ExternalFileTrustContext {
    return {
      port,
      workspaceRoot,
      workflowSourcePath,
      trustStore,
      onWorkflowRootsUpdated,
    };
  }

  test("writes a user-scope root when the user chooses all workspaces", async () => {
    ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks = () => true;
    const roots: string[] = [];
    ConfigurationUtils.addUserAllowedExternalFileRoot = async (root) => {
      roots.push(root);
    };
    const candidate = path.join(os.tmpdir(), "user-scope", "file.txt");

    assert.strictEqual(
      await confirmExternalFileTrust(
        candidate,
        context(new FakeInteractionPort(EXTERNAL_FILE_TRUST_SCOPES.USER))
      ),
      true
    );
    assert.deepStrictEqual(roots, [path.dirname(candidate)]);
  });

  test("writes and immediately approves a workspace-scope root", async () => {
    ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks = () => true;
    const roots: string[] = [];
    ConfigurationUtils.addWorkspaceAllowedExternalFileRoot = async (root) => {
      roots.push(root);
    };
    const trustStore = new RecordingTrustStore();
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-trust-workspace-")
    );
    tempPaths.push(workspaceRoot);
    const candidate = path.join(workspaceRoot, "outside", "file.txt");

    assert.strictEqual(
      await confirmExternalFileTrust(
        candidate,
        context(
          new FakeInteractionPort(EXTERNAL_FILE_TRUST_SCOPES.WORKSPACE),
          workspaceRoot,
          undefined,
          trustStore
        )
      ),
      true
    );
    assert.deepStrictEqual(roots, [path.dirname(candidate)]);
    assert.strictEqual(trustStore.decisions[0].decision, TRUST_DECISIONS.ALLOW);
  });

  test("seeds an inheriting workflow from its effective roots before appending", async () => {
    ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks = () => true;
    ConfigurationUtils.getEffectiveApprovedExternalFileRoots = () => [
      path.join(os.tmpdir(), "already-trusted"),
    ];
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-trust-workflow-")
    );
    tempPaths.push(workspaceRoot);
    const sourcePath = path.join(workspaceRoot, "workflow.ctrlyoke.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({ steps: [{ prompt: "run" }] })
    );
    const trustStore = new RecordingTrustStore();
    let updatedRoots: string[] | undefined;
    const candidate = path.join(workspaceRoot, "external", "file.txt");
    const port = new FakeInteractionPort(EXTERNAL_FILE_TRUST_SCOPES.WORKFLOW);

    assert.strictEqual(
      await confirmExternalFileTrust(
        candidate,
        context(port, workspaceRoot, sourcePath, trustStore, async (roots) => {
          updatedRoots = roots;
        })
      ),
      true
    );
    const written = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    assert.deepStrictEqual(written.trustedExternalRoots, [
      path.join(os.tmpdir(), "already-trusted"),
      path.dirname(candidate),
    ]);
    assert.deepStrictEqual(updatedRoots, written.trustedExternalRoots);
    assert.strictEqual(
      trustStore.decisions[0].scopeIdentity.startsWith("workflow:"),
      true
    );
  });

  test("appends to an existing explicit workflow root list", async () => {
    ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks = () => true;
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-trust-explicit-")
    );
    tempPaths.push(workspaceRoot);
    const existingRoot = path.join(workspaceRoot, "existing");
    const sourcePath = path.join(workspaceRoot, "workflow.ctrlyoke.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        steps: [{ prompt: "run" }],
        trustedExternalRoots: [existingRoot],
      })
    );
    const candidate = path.join(workspaceRoot, "external", "file.txt");
    const trustStore = new RecordingTrustStore();

    await confirmExternalFileTrust(
      candidate,
      context(
        new FakeInteractionPort(EXTERNAL_FILE_TRUST_SCOPES.WORKFLOW),
        workspaceRoot,
        sourcePath,
        trustStore
      )
    );
    const written = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    assert.deepStrictEqual(written.trustedExternalRoots, [
      existingRoot,
      path.dirname(candidate),
    ]);
  });

  test("preserves YAML source when adding workflow-scoped trust", async () => {
    ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks = () => true;
    const existingRoot = path.join(os.tmpdir(), "existing-workflow-root");
    ConfigurationUtils.getEffectiveApprovedExternalFileRoots = () => [
      existingRoot,
    ];
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-trust-workflow-yaml-")
    );
    tempPaths.push(workspaceRoot);
    const sourcePath = path.join(workspaceRoot, "workflow.ctrlyoke.yaml");
    const source = [
      "# Keep the author's comment.",
      "defaults: &defaults",
      "  model: fast-model",
      "  prompt: |",
      "    This long prompt line should remain byte-for-byte the same after trusting a folder.",
      "steps:",
      "  - <<: *defaults",
      "    prompt: Run this workflow.",
      "",
    ].join("\n");
    await fs.writeFile(sourcePath, source, "utf8");
    const candidate = path.join(workspaceRoot, "external", "file.txt");
    const roots = [existingRoot, path.dirname(candidate)];

    await confirmExternalFileTrust(
      candidate,
      context(
        new FakeInteractionPort(EXTERNAL_FILE_TRUST_SCOPES.WORKFLOW),
        workspaceRoot,
        sourcePath,
        new RecordingTrustStore()
      )
    );

    const written = await fs.readFile(sourcePath, "utf8");
    assert.ok(written.startsWith(source));
    const parsed = parseDocument(written, { merge: true }).toJS() as {
      trustedExternalRoots: string[];
    };
    assert.deepStrictEqual(parsed.trustedExternalRoots, roots);
  });
});
