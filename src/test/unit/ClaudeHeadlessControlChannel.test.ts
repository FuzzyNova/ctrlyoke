import * as assert from "assert";
import { suite, test } from "mocha";
import { ClaudeHeadlessControlChannel } from "../../core/harness/claude/ClaudeHeadlessControlChannel";
import type { ControlWriter } from "../../core/harness/shared/IHeadlessControlChannel";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
} from "../../types/DashboardConstants";
import {
  CLAUDE_CONTROL,
  CLAUDE_EVENT_TYPES,
} from "../../core/harness/claude/ClaudeProtocolConstants";

suite("ClaudeHeadlessControlChannel", () => {
  test("sends the first user message without an initialize handshake", async () => {
    const writes: string[] = [];
    const writer: ControlWriter = {
      write: async (text) => {
        writes.push(text);
      },
      end: async () => {},
    };
    const channel = new ClaudeHeadlessControlChannel();

    await channel.start(writer);
    assert.deepStrictEqual(writes, []);
    await channel.sendUserMessage("hello Claude");

    assert.deepStrictEqual(JSON.parse(writes[0]), {
      type: CLAUDE_CONTROL.USER_TYPE,
      message: { role: CLAUDE_CONTROL.USER_ROLE, content: "hello Claude" },
      parent_tool_use_id: null,
    });
    assert.strictEqual(channel.steerDelivery, HEADLESS_STEER_DELIVERIES.INJECT);
    assert.strictEqual(channel.holdOpenForBackgroundWork, true);
    channel.close();
  });

  test("answers can_use_tool with deny and observes result as turn end", async () => {
    const writes: string[] = [];
    const channel = new ClaudeHeadlessControlChannel();
    await channel.start({
      write: async (text) => {
        writes.push(text);
      },
      end: async () => {},
    });

    assert.deepStrictEqual(
      channel.observe({
        type: CLAUDE_CONTROL.REQUEST_TYPE,
        request_id: "approval-1",
        request: { subtype: CLAUDE_CONTROL.CAN_USE_TOOL_SUBTYPE },
      }),
      [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
          requestId: "approval-1",
        },
      ]
    );
    await channel.answerApproval(
      "approval-1",
      APPROVAL_DECISIONS.DENY,
      "ctrlyoke denied this request"
    );
    assert.deepStrictEqual(JSON.parse(writes[0]), {
      type: CLAUDE_CONTROL.RESPONSE_TYPE,
      response: {
        subtype: CLAUDE_CONTROL.SUCCESS_SUBTYPE,
        request_id: "approval-1",
        response: {
          behavior: CLAUDE_CONTROL.DENY_BEHAVIOR,
          message: "ctrlyoke denied this request",
        },
      },
    });
    assert.deepStrictEqual(channel.observe({ type: CLAUDE_EVENT_TYPES.RESULT }), [
      { kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END },
    ]);
    await assert.rejects(
      channel.answerApproval("approval-2", APPROVAL_DECISIONS.ALLOW_ONCE),
      /only support deny/
    );
    channel.close();
  });
});
