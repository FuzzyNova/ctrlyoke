import * as assert from "assert";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { SecretGrantsTrustStore } from "../../config/SecretGrantsTrustStore";
import {
  PendingSecretGrantsError,
  promptBatchApprovalForPendingWorkspaceSecretGrants,
} from "../../ui/SecretGrantsTrustPrompt";
import {
  NullUserInteractionPort,
  type BatchApprovalRequest,
  type BatchApprovalResult,
  type UserInteractionPort,
} from "../../ui/UserInteractionPort";
import type { PromptFile } from "../../types/CtrlYokeTypes";

class FakeInteractionPort implements UserInteractionPort {
  requestCalls = 0;
  lastRequest: BatchApprovalRequest | undefined;
  private response: BatchApprovalResult | undefined;

  constructor(response: BatchApprovalResult | undefined) {
    this.response = response;
  }

  canPrompt(): boolean {
    return true;
  }

  async requestBatchApproval(
    request: BatchApprovalRequest
  ): Promise<BatchApprovalResult | undefined> {
    this.requestCalls += 1;
    this.lastRequest = request;
    return this.response;
  }

  async requestChoice(): Promise<string | undefined> {
    return undefined;
  }
}

suite("SecretGrantsTrustPrompt", () => {
  let tempDir: string;
  let store: SecretGrantsTrustStore;

  setup(() => {
    tempDir = makeTempDir("ctrlyoke-secret-grants-prompt-");
    store = new SecretGrantsTrustStore(path.join(tempDir, "trust.json"));
  });

  teardown(() => {
    removeTempDir(tempDir);
  });

  const workflow: PromptFile = {
    steps: [
      { prompt: "deploy", secrets: ["FIRST_TOKEN", "SECOND_TOKEN"] },
      { prompt: "verify", secrets: ["SECOND_TOKEN", "THIRD_TOKEN"] },
    ],
  };

  test("shows all pending names in one request and persists checked/unchecked decisions", async () => {
    const port = new FakeInteractionPort({
      approvedValues: ["FIRST_TOKEN"],
      deniedValues: ["SECOND_TOKEN", "THIRD_TOKEN"],
    });

    await promptBatchApprovalForPendingWorkspaceSecretGrants(
      workflow,
      tempDir,
      port,
      store
    );

    assert.strictEqual(port.requestCalls, 1);
    assert.deepStrictEqual(
      port.lastRequest?.items.map((item) => item.value),
      ["FIRST_TOKEN", "SECOND_TOKEN", "THIRD_TOKEN"]
    );
    assert.deepStrictEqual(
      port.lastRequest?.items.map((item) => item.checked),
      [true, true, true]
    );
    assert.strictEqual(store.getDecision(tempDir, "FIRST_TOKEN"), "allow");
    assert.strictEqual(store.getDecision(tempDir, "SECOND_TOKEN"), "deny");
    assert.strictEqual(store.getDecision(tempDir, "THIRD_TOKEN"), "deny");
  });

  test("leaves every name pending when the request is dismissed", async () => {
    const port = new FakeInteractionPort(undefined);

    await promptBatchApprovalForPendingWorkspaceSecretGrants(
      workflow,
      tempDir,
      port,
      store
    );

    assert.strictEqual(port.requestCalls, 1);
    assert.deepStrictEqual(
      store.getPendingGrants(tempDir, [
        "FIRST_TOKEN",
        "SECOND_TOKEN",
        "THIRD_TOKEN",
      ]),
      ["FIRST_TOKEN", "SECOND_TOKEN", "THIRD_TOKEN"]
    );
  });

  test("does not call the port when there are no pending grants", async () => {
    await store.setDecisions(
      tempDir,
      ["FIRST_TOKEN", "SECOND_TOKEN", "THIRD_TOKEN"],
      "allow"
    );
    const port = new FakeInteractionPort(undefined);

    await promptBatchApprovalForPendingWorkspaceSecretGrants(
      workflow,
      tempDir,
      port,
      store
    );

    assert.strictEqual(port.requestCalls, 0);
  });

  test("offers denied grants again while excluding grants already allowed", async () => {
    await store.setDecisions(tempDir, ["FIRST_TOKEN"], "allow");
    await store.setDecisions(tempDir, ["SECOND_TOKEN"], "deny");
    const port = new FakeInteractionPort({
      approvedValues: ["SECOND_TOKEN", "THIRD_TOKEN"],
      deniedValues: [],
    });

    await promptBatchApprovalForPendingWorkspaceSecretGrants(
      workflow,
      tempDir,
      port,
      store
    );

    assert.deepStrictEqual(
      port.lastRequest?.items.map((item) => item.value),
      ["SECOND_TOKEN", "THIRD_TOKEN"]
    );
    assert.strictEqual(store.getDecision(tempDir, "SECOND_TOKEN"), "allow");
  });

  test("throws a named error naming the pending grants when the port cannot prompt", async () => {
    const port = new NullUserInteractionPort();

    await assert.rejects(
      promptBatchApprovalForPendingWorkspaceSecretGrants(
        workflow,
        tempDir,
        port,
        store
      ),
      (error: unknown) => {
        assert.ok(error instanceof PendingSecretGrantsError);
        assert.deepStrictEqual([...error.secretNames].sort(), [
          "FIRST_TOKEN",
          "SECOND_TOKEN",
          "THIRD_TOKEN",
        ]);
        assert.match(error.message, /ctrlyoke trust-secret-grants/);
        return true;
      }
    );
    assert.deepStrictEqual(
      store.getPendingGrants(tempDir, [
        "FIRST_TOKEN",
        "SECOND_TOKEN",
        "THIRD_TOKEN",
      ]),
      ["FIRST_TOKEN", "SECOND_TOKEN", "THIRD_TOKEN"]
    );
  });
});
