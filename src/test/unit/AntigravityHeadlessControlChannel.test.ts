import * as assert from "assert";
import { suite, test } from "mocha";
import { AntigravityHeadlessControlChannel } from "../../core/harness/antigravity/AntigravityHeadlessControlChannel";
import type { ControlWriter } from "../../core/harness/shared/IHeadlessControlChannel";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
} from "../../types/DashboardConstants";
import {
  ANTIGRAVITY_STREAM_JSON_EVENTS,
  ANTIGRAVITY_STREAM_JSON_INPUT_EVENTS,
  ANTIGRAVITY_STREAM_JSON_USER_ROLE,
} from "../../core/harness/antigravity/AntigravityProtocolConstants";

suite("AntigravityHeadlessControlChannel", () => {
  test("sends user records and queues steering after the current turn", async () => {
    const writes: string[] = [];
    const writer: ControlWriter = {
      write: async (text) => {
        writes.push(text);
      },
      end: async () => {},
    };
    const channel = new AntigravityHeadlessControlChannel();

    await channel.start(writer);
    await channel.sendUserMessage("hello Antigravity");

    assert.deepStrictEqual(JSON.parse(writes[0]), {
      event: ANTIGRAVITY_STREAM_JSON_INPUT_EVENTS.USER,
      message: {
        role: ANTIGRAVITY_STREAM_JSON_USER_ROLE,
        content: "hello Antigravity",
      },
    });
    assert.strictEqual(channel.steerDelivery, HEADLESS_STEER_DELIVERIES.QUEUE);
    channel.close();
  });

  test("observes only terminal result events as turn ends", () => {
    const channel = new AntigravityHeadlessControlChannel();

    assert.deepStrictEqual(
      channel.observe({ event: ANTIGRAVITY_STREAM_JSON_EVENTS.STEP_UPDATE }),
      []
    );
    assert.deepStrictEqual(
      channel.observe({ type: ANTIGRAVITY_STREAM_JSON_EVENTS.RESULT }),
      []
    );
    assert.deepStrictEqual(
      channel.observe({ event: ANTIGRAVITY_STREAM_JSON_EVENTS.RESULT }),
      [{ kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END }]
    );
  });

  test("does not accept approval responses", async () => {
    const channel = new AntigravityHeadlessControlChannel();
    await assert.rejects(
      channel.answerApproval("request-1", APPROVAL_DECISIONS.DENY),
      /does not support headless approval responses/
    );
  });
});
