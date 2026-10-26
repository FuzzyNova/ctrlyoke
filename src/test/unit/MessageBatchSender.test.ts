import { suite, test } from "mocha";
import * as assert from "assert";
import { sendAsMessageBatch } from "../../ui/MessageBatchSender";
import { PostMessageDashboardSink } from "../../ui/PostMessageDashboardSink";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";
import type { MessageBatchMessage } from "../../types/WebviewMessageTypes";

type Sent = { type: string; [key: string]: unknown };

suite("sendAsMessageBatch", () => {
  test("delivers everything emitted as one batch, in emission order", () => {
    const sent: Sent[] = [];
    sendAsMessageBatch(
      (message) => sent.push(message),
      (batchSend) => {
        const sink = new PostMessageDashboardSink(batchSend);
        sink.updateRetryAttempt(2, 1, 3);
        sink.updateCliOutput(2, { text: "a" });
        sink.updateExecutionState(EXECUTION_STATES.PAUSING);
        sink.updateCliOutput(3, { text: "b" });
      }
    );

    assert.strictEqual(sent.length, 1);
    const batch = sent[0] as unknown as MessageBatchMessage;
    assert.strictEqual(batch.type, MESSAGE_TYPES.MESSAGE_BATCH);
    assert.deepStrictEqual(
      batch.messages.map((message) => message.type),
      [
        MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED,
        MESSAGE_TYPES.CLI_OUTPUT,
        MESSAGE_TYPES.EXECUTION_STATE_CHANGED,
        MESSAGE_TYPES.CLI_OUTPUT,
      ]
    );
    assert.deepStrictEqual(
      batch.messages
        .filter((message) => message.type === MESSAGE_TYPES.CLI_OUTPUT)
        .map((message) => message.stepIndex),
      [2, 3]
    );
  });

  test("sends a lone message as itself and nothing for an empty replay", () => {
    const sent: Sent[] = [];
    sendAsMessageBatch(
      (message) => sent.push(message),
      (batchSend) => batchSend({ type: MESSAGE_TYPES.CLI_OUTPUT, n: 1 })
    );
    sendAsMessageBatch(
      (message) => sent.push(message),
      () => {}
    );
    assert.deepStrictEqual(sent, [{ type: MESSAGE_TYPES.CLI_OUTPUT, n: 1 }]);
  });

  test("still delivers what was emitted before a throw, then rethrows", () => {
    const sent: Sent[] = [];
    assert.throws(
      () =>
        sendAsMessageBatch(
          (message) => sent.push(message),
          (batchSend) => {
            batchSend({ type: MESSAGE_TYPES.CLI_OUTPUT, n: 1 });
            batchSend({ type: MESSAGE_TYPES.CLI_OUTPUT, n: 2 });
            throw new Error("replay failed");
          }
        ),
      /replay failed/
    );
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(
      (sent[0] as unknown as MessageBatchMessage).messages.map((m) => m.n),
      [1, 2]
    );
  });

  test("passes sends made after emit returns straight through", () => {
    const sent: Sent[] = [];
    let late: ((message: unknown) => void) | undefined;
    sendAsMessageBatch(
      (message) => sent.push(message),
      (batchSend) => {
        late = batchSend;
        batchSend({ type: MESSAGE_TYPES.CLI_OUTPUT, n: 1 });
      }
    );
    late?.({ type: MESSAGE_TYPES.STATUS_MESSAGE, n: 2 });
    assert.deepStrictEqual(sent, [
      { type: MESSAGE_TYPES.CLI_OUTPUT, n: 1 },
      { type: MESSAGE_TYPES.STATUS_MESSAGE, n: 2 },
    ]);
  });
});
