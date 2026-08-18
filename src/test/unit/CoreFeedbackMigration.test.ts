import * as assert from "assert";
import { suite, test } from "mocha";
import { createWebviewClientContext } from "../../ui/WebviewClientContext";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";

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
});
