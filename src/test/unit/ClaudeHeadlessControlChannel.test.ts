import * as assert from "assert";
import { suite, test } from "mocha";
import { ClaudeHeadlessControlChannel } from "../../core/harness/claude/ClaudeHeadlessControlChannel";
import type { ControlWriter } from "../../core/harness/shared/IHeadlessControlChannel";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_APPROVAL_POLICIES,
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
    channel.close();
  });

  test("initializes Claude's stdio approval protocol when ask is enabled", async () => {
    const writes: string[] = [];
    const channel = new ClaudeHeadlessControlChannel({
      approvalPolicy: HEADLESS_APPROVAL_POLICIES.ASK,
      approvalTimeoutMs: 30_000,
      useApprovalControl: true,
    });
    await channel.start({
      write: async (text) => {
        writes.push(text);
        const request = JSON.parse(text) as {
          request_id: string;
          request: { subtype: string };
        };
        if (request.request.subtype === CLAUDE_CONTROL.INITIALIZE_SUBTYPE) {
          channel.observe({
            type: CLAUDE_CONTROL.RESPONSE_TYPE,
            response: { request_id: request.request_id },
          });
        }
      },
      end: async () => {},
    });

    assert.deepStrictEqual(JSON.parse(writes[0]), {
      type: CLAUDE_CONTROL.REQUEST_TYPE,
      request_id: (JSON.parse(writes[0]) as { request_id: string }).request_id,
      request: { subtype: CLAUDE_CONTROL.INITIALIZE_SUBTYPE },
    });
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
          toolName: "Unknown tool",
          input: undefined,
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
    assert.deepStrictEqual(
      channel.observe({ type: CLAUDE_EVENT_TYPES.RESULT }),
      [{ kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END }]
    );
    const allowInput = { command: "echo hello" };
    channel.observe({
      type: CLAUDE_CONTROL.REQUEST_TYPE,
      request_id: "approval-2",
      request: {
        subtype: CLAUDE_CONTROL.CAN_USE_TOOL_SUBTYPE,
        tool_name: "Bash",
        input: allowInput,
      },
    });
    await channel.answerApproval("approval-2", APPROVAL_DECISIONS.ALLOW_ONCE);
    assert.deepStrictEqual(JSON.parse(writes[1]), {
      type: CLAUDE_CONTROL.RESPONSE_TYPE,
      response: {
        subtype: CLAUDE_CONTROL.SUCCESS_SUBTYPE,
        request_id: "approval-2",
        response: {
          behavior: CLAUDE_CONTROL.ALLOW_BEHAVIOR,
          updatedInput: allowInput,
        },
      },
    });
    channel.close();
  });

  test("classifies AskUserQuestion separately from tool approvals", () => {
    const channel = new ClaudeHeadlessControlChannel();
    assert.deepStrictEqual(
      channel.observe({
        type: CLAUDE_CONTROL.REQUEST_TYPE,
        request_id: "question-1",
        request: {
          subtype: CLAUDE_CONTROL.CAN_USE_TOOL_SUBTYPE,
          tool_name: CLAUDE_CONTROL.ASK_USER_QUESTION_TOOL,
        },
      }),
      [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.MODEL_QUESTION,
          requestId: "question-1",
        },
      ]
    );
    channel.close();
  });

  test("sends interrupt and marks the following result as interrupted", async () => {
    const writes: string[] = [];
    const channel = new ClaudeHeadlessControlChannel();
    await channel.start({
      write: async (text) => {
        writes.push(text);
      },
      end: async () => {},
    });

    await channel.interrupt();

    const request = JSON.parse(writes[0]) as {
      type: string;
      request_id: string;
      request: { subtype: string };
    };
    assert.strictEqual(request.type, CLAUDE_CONTROL.REQUEST_TYPE);
    assert.strictEqual(
      request.request.subtype,
      CLAUDE_CONTROL.INTERRUPT_SUBTYPE
    );
    assert.ok(request.request_id);
    assert.deepStrictEqual(
      channel.observe({ type: CLAUDE_EVENT_TYPES.RESULT }),
      [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END,
          interrupted: true,
        },
      ]
    );
    channel.close();
  });
});
