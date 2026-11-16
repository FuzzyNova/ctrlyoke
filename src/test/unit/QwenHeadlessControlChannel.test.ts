import * as assert from "assert";
import { suite, test } from "mocha";
import { QwenHeadlessControlChannel } from "../../core/harness/qwen/QwenHeadlessControlChannel";
import { CliTransportError } from "../../core/harness/shared/CliTransportError";
import type { ControlWriter } from "../../core/harness/shared/IHeadlessControlChannel";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
} from "../../types/DashboardConstants";
import {
  QWEN_CONTROL,
  QWEN_EVENT_TYPES,
} from "../../core/harness/qwen/QwenProtocolConstants";

suite("QwenHeadlessControlChannel", () => {
  test("waits for the matching initialize response before accepting a user message", async () => {
    const writes: string[] = [];
    const writer: ControlWriter = {
      write: async (text) => {
        writes.push(text);
      },
      end: async () => {},
    };
    const channel = new QwenHeadlessControlChannel();
    const starting = channel.start(writer);

    const initialize = JSON.parse(writes[0]) as {
      type: string;
      request_id: string;
      request: { subtype: string };
    };
    assert.strictEqual(initialize.type, QWEN_CONTROL.REQUEST_TYPE);
    assert.strictEqual(initialize.request.subtype, QWEN_CONTROL.INITIALIZE_SUBTYPE);
    assert.strictEqual(channel.steerDelivery, HEADLESS_STEER_DELIVERIES.QUEUE);

    channel.observe({
      type: QWEN_CONTROL.RESPONSE_TYPE,
      response: { request_id: "another-request" },
    });
    await Promise.resolve();
    assert.strictEqual(writes.length, 1);

    channel.observe({
      type: QWEN_CONTROL.RESPONSE_TYPE,
      response: { request_id: initialize.request_id },
    });
    await starting;
    await channel.sendUserMessage("hello Qwen");

    const userMessage = JSON.parse(writes[1]) as Record<string, unknown>;
    assert.deepStrictEqual(userMessage, {
      type: QWEN_CONTROL.USER_TYPE,
      session_id: userMessage.session_id,
      message: { role: QWEN_CONTROL.USER_ROLE, content: "hello Qwen" },
      parent_tool_use_id: null,
    });
    assert.strictEqual(typeof userMessage.session_id, "string");
    channel.close();
  });

  test("maps can_use_tool to a deny response and result to turn end", async () => {
    const writes: string[] = [];
    const channel = new QwenHeadlessControlChannel();
    await channel.start({
      write: async (text) => {
        writes.push(text);
        if (text.includes(QWEN_CONTROL.INITIALIZE_SUBTYPE)) {
          const request = JSON.parse(text) as { request_id: string };
          channel.observe({
            type: QWEN_CONTROL.RESPONSE_TYPE,
            response: { request_id: request.request_id },
          });
        }
      },
      end: async () => {},
    });

    const approval = channel.observe({
      type: QWEN_CONTROL.REQUEST_TYPE,
      request_id: "approval-7",
      request: { subtype: QWEN_CONTROL.CAN_USE_TOOL_SUBTYPE },
    });
    assert.deepStrictEqual(approval, [
      {
        kind: HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
        requestId: "approval-7",
      },
    ]);
    await channel.answerApproval(
      "approval-7",
      APPROVAL_DECISIONS.DENY,
      "ctrlyoke denied this request"
    );
    assert.deepStrictEqual(JSON.parse(writes[1]), {
      type: QWEN_CONTROL.RESPONSE_TYPE,
      request_id: "approval-7",
      response: {
        behavior: QWEN_CONTROL.DENY_BEHAVIOR,
        message: "ctrlyoke denied this request",
      },
    });
    assert.deepStrictEqual(channel.observe({ type: QWEN_EVENT_TYPES.RESULT }), [
      { kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END },
    ]);
    channel.close();
  });

  test("fails a missing initialize response with a transport error", async () => {
    const channel = new QwenHeadlessControlChannel(5);
    await assert.rejects(
      channel.start({ write: async () => {}, end: async () => {} }),
      (error: unknown) =>
        error instanceof CliTransportError &&
        error.message.includes("did not answer the headless initialize")
    );
    channel.close();
  });
});
