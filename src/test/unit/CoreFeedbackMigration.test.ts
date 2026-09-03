import * as assert from "assert";
import { suite, test } from "mocha";
import { createWebviewClientContext } from "../../ui/WebviewClientContext";
import {
  EXTERNAL_FILE_TRUST_SCOPES,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";
import {
  promptBatchApprovalForPendingRoots,
} from "../../ui/ExternalFileTrustPrompt";
import { WebviewUserInteractionPort } from "../../ui/WebviewUserInteractionPort";

suite("Core feedback migration", () => {
  test("emits a scoped failure only through the initiating client transport", () => {
    const firstClient: unknown[] = [];
    const secondClient: unknown[] = [];
    const contexts = [
      createWebviewClientContext("browser:1", (message) => {
        firstClient.push(message);
      }),
      createWebviewClientContext("browser:2", (message) => {
        secondClient.push(message);
      }),
    ];

    contexts[0].emit({
      type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
      action: "load workflow",
      error: "invalid workflow",
    });

    assert.strictEqual(firstClient.length, 1);
    assert.deepStrictEqual(secondClient, []);
  });

  test("routes workflow root approval and choices only to the requesting tab", async () => {
    const firstClient: unknown[] = [];
    const secondClient: unknown[] = [];
    const firstPort = new WebviewUserInteractionPort(
      (message) => firstClient.push(message),
      () => true
    );
    const decisions: unknown[] = [];
    const store = {
      setDecisions: async (
        scopeIdentity: string,
        roots: readonly string[],
        decision: string
      ) => {
        decisions.push({ scopeIdentity, roots, decision });
      },
    };

    const approval = promptBatchApprovalForPendingRoots(
      "workflow:one",
      ["C:\\external"],
      "Workflow roots",
      firstPort,
      store
    );
    const approvalMessage = firstClient[0] as {
      request: { id: string };
    };
    assert.strictEqual(secondClient.length, 0);
    firstPort.handleResponse(approvalMessage.request.id, {
      approvedValues: ["C:\\external"],
      deniedValues: [],
    });
    await approval;
    assert.strictEqual(decisions.length, 1);

    const choice = firstPort.requestChoice({
      id: "choice-one",
      title: "Trust Parent Folder",
      detail: "Choose a scope",
      choices: [
        {
          value: EXTERNAL_FILE_TRUST_SCOPES.WORKSPACE,
          label: "Trust for this workspace",
        },
      ],
    });
    assert.strictEqual(firstClient.length, 2);
    assert.strictEqual(secondClient.length, 0);
    firstPort.handleChoiceResponse(
      "choice-one",
      EXTERNAL_FILE_TRUST_SCOPES.WORKSPACE
    );
    assert.strictEqual(await choice, EXTERNAL_FILE_TRUST_SCOPES.WORKSPACE);
  });
});
