import * as assert from "assert";
import { suite, test } from "mocha";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
} from "../../types/DashboardConstants";
import { CTRLYOKE_VERSION } from "../../utils/BuildConfig";
import type { ControlWriter } from "../../core/harness/shared/IHeadlessControlChannel";
import { CodexAppServerHeadlessControlChannel } from "../../core/harness/codex/CodexAppServerHeadlessControlChannel";
import { CODEX_APP_SERVER_METHODS } from "../../core/harness/codex/CodexProtocolConstants";

class RecordingControlWriter implements ControlWriter {
  readonly writes: string[] = [];
  ended = false;

  async write(text: string): Promise<void> {
    this.writes.push(text);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  read(index: number): Record<string, unknown> {
    const line = this.writes[index];
    if (!line) throw new Error(`Missing write ${index}`);
    return JSON.parse(line) as Record<string, unknown>;
  }
}

async function settlePendingRequest(
  channel: CodexAppServerHeadlessControlChannel,
  writer: RecordingControlWriter,
  writeIndex: number,
  result: unknown
): Promise<void> {
  const request = writer.read(writeIndex);
  channel.observe({ id: request.id, result });
  await waitForWriteCount(writer, writeIndex + 1);
}

async function waitForWriteCount(
  writer: RecordingControlWriter,
  count: number
): Promise<void> {
  while (writer.writes.length < count) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

suite("CodexAppServerHeadlessControlChannel", () => {
  test("initializes, starts a paginated thread, and delivers text plus images", async () => {
    const writer = new RecordingControlWriter();
    const channel = new CodexAppServerHeadlessControlChannel({
      context: {
        imageFilePaths: ["/workspace/image.png"],
      },
    });

    const starting = channel.start(writer);
    const initialize = writer.read(0);
    assert.strictEqual(initialize.method, CODEX_APP_SERVER_METHODS.INITIALIZE);
    assert.deepStrictEqual(initialize.params, {
      clientInfo: {
        name: "ctrlyoke",
        title: "ctrlyoke",
        version: CTRLYOKE_VERSION,
      },
      capabilities: { experimentalApi: true },
    });
    await settlePendingRequest(channel, writer, 0, {});
    await waitForWriteCount(writer, 3);

    const initialized = writer.read(1);
    assert.strictEqual(
      initialized.method,
      CODEX_APP_SERVER_METHODS.INITIALIZED
    );
    assert.strictEqual(initialized.params, undefined);
    const threadStart = writer.read(2);
    assert.strictEqual(
      threadStart.method,
      CODEX_APP_SERVER_METHODS.THREAD_START
    );
    assert.deepStrictEqual(threadStart.params, {
      historyMode: "paginated",
      config: { bypass_hook_trust: true },
    });
    await settlePendingRequest(channel, writer, 2, {
      thread: { id: "thread-new" },
    });
    await starting;

    const sending = channel.sendUserMessage("review this image");
    const turnStart = writer.read(3);
    assert.strictEqual(turnStart.method, CODEX_APP_SERVER_METHODS.TURN_START);
    assert.deepStrictEqual(turnStart.params, {
      threadId: "thread-new",
      input: [
        { type: "text", text: "review this image", textElements: [] },
        { type: "localImage", path: "/workspace/image.png" },
      ],
    });
    await settlePendingRequest(channel, writer, 3, {
      turn: { id: "turn-new" },
    });
    await sending;

    assert.deepStrictEqual(
      channel.observe({
        method: CODEX_APP_SERVER_METHODS.TURN_COMPLETED,
        params: { threadId: "thread-new", turn: { id: "turn-new" } },
      }),
      [{ kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END }]
    );
    assert.deepStrictEqual(
      channel.observe({
        method: CODEX_APP_SERVER_METHODS.TURN_COMPLETED,
        params: { threadId: "another-thread" },
      }),
      []
    );
    channel.close();
  });

  test("steers and interrupts the active turn, and rejects a late steer", async () => {
    const writer = new RecordingControlWriter();
    const channel = new CodexAppServerHeadlessControlChannel();
    const starting = channel.start(writer);

    await settlePendingRequest(channel, writer, 0, {});
    await waitForWriteCount(writer, 3);
    await settlePendingRequest(channel, writer, 2, {
      thread: { id: "thread-control" },
    });
    await starting;
    assert.strictEqual(channel.steerDelivery, HEADLESS_STEER_DELIVERIES.INJECT);

    const initialPrompt = channel.sendUserMessage("initial prompt");
    const turnStart = writer.read(3);
    assert.strictEqual(turnStart.method, CODEX_APP_SERVER_METHODS.TURN_START);
    await settlePendingRequest(channel, writer, 3, {
      turn: { id: "turn-running" },
    });
    await initialPrompt;

    const steering = channel.sendUserMessage("steer text");
    const turnSteer = writer.read(4);
    assert.strictEqual(turnSteer.method, CODEX_APP_SERVER_METHODS.TURN_STEER);
    assert.deepStrictEqual(turnSteer.params, {
      threadId: "thread-control",
      input: [{ type: "text", text: "steer text", textElements: [] }],
      expectedTurnId: "turn-running",
    });
    await settlePendingRequest(channel, writer, 4, {});
    await steering;

    const interrupting = channel.interrupt();
    const turnInterrupt = writer.read(5);
    assert.strictEqual(
      turnInterrupt.method,
      CODEX_APP_SERVER_METHODS.TURN_INTERRUPT
    );
    assert.deepStrictEqual(turnInterrupt.params, {
      threadId: "thread-control",
      turnId: "turn-running",
    });
    await settlePendingRequest(channel, writer, 5, {});
    await interrupting;

    assert.deepStrictEqual(
      channel.observe({
        method: CODEX_APP_SERVER_METHODS.TURN_COMPLETED,
        params: { threadId: "thread-control", turn: { id: "turn-running" } },
      }),
      [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END,
          interrupted: true,
        },
      ]
    );
    const writeCountAfterCompletion = writer.writes.length;
    await assert.rejects(
      channel.sendUserMessage("too late"),
      /turn completed before the steer.*not queued/
    );
    assert.strictEqual(writer.writes.length, writeCountAfterCompletion);
    channel.close();
  });

  test("resumes the existing thread with hook trust bypass", async () => {
    const writer = new RecordingControlWriter();
    const channel = new CodexAppServerHeadlessControlChannel({
      context: { sessionId: "thread-resumed" },
    });
    const starting = channel.start(writer);

    await settlePendingRequest(channel, writer, 0, {});
    await waitForWriteCount(writer, 3);
    const threadResume = writer.read(2);
    assert.strictEqual(
      threadResume.method,
      CODEX_APP_SERVER_METHODS.THREAD_RESUME
    );
    assert.deepStrictEqual(threadResume.params, {
      threadId: "thread-resumed",
      config: { bypass_hook_trust: true },
      excludeTurns: true,
    });
    await settlePendingRequest(channel, writer, 2, {
      thread: { id: "thread-resumed" },
    });
    await starting;
    channel.close();
  });

  test("adds launch writable roots without replacing configured roots", async () => {
    const writer = new RecordingControlWriter();
    const channel = new CodexAppServerHeadlessControlChannel({
      additionalWritableRoots: ["/workspace/.git", "/external"],
    });
    const starting = channel.start(writer);

    await settlePendingRequest(channel, writer, 0, {});
    await waitForWriteCount(writer, 3);
    await settlePendingRequest(channel, writer, 2, {
      config: {
        sandbox_workspace_write: {
          writable_roots: ["/configured"],
        },
      },
    });
    await waitForWriteCount(writer, 4);
    const threadStart = writer.read(3);
    assert.strictEqual(
      threadStart.method,
      CODEX_APP_SERVER_METHODS.THREAD_START
    );
    assert.deepStrictEqual(threadStart.params, {
      historyMode: "paginated",
      config: {
        bypass_hook_trust: true,
        "sandbox_workspace_write.writable_roots": [
          "/configured",
          "/workspace/.git",
          "/external",
        ],
      },
    });
    await settlePendingRequest(channel, writer, 3, {
      thread: { id: "thread-roots" },
    });
    await starting;
    channel.close();
  });

  test("answers Codex approvals once or declines without a session-wide grant", async () => {
    const writer = new RecordingControlWriter();
    const channel = new CodexAppServerHeadlessControlChannel();
    const requests = [
      {
        id: 11,
        method: CODEX_APP_SERVER_METHODS.COMMAND_APPROVAL,
        params: { command: "node script.js" },
        decision: APPROVAL_DECISIONS.ALLOW_ONCE,
        expectedResponse: { decision: "accept" },
      },
      {
        id: 12,
        method: CODEX_APP_SERVER_METHODS.COMMAND_APPROVAL,
        params: { command: "node denied.js" },
        decision: APPROVAL_DECISIONS.DENY,
        expectedResponse: { decision: "decline" },
      },
      {
        id: 13,
        method: CODEX_APP_SERVER_METHODS.FILE_CHANGE_APPROVAL,
        params: { reason: "write outside the workspace" },
        decision: APPROVAL_DECISIONS.ALLOW_ONCE,
        expectedResponse: { decision: "accept" },
      },
      {
        id: 14,
        method: CODEX_APP_SERVER_METHODS.FILE_CHANGE_APPROVAL,
        params: { reason: "denied file change" },
        decision: APPROVAL_DECISIONS.DENY,
        expectedResponse: { decision: "decline" },
      },
      {
        id: 15,
        method: CODEX_APP_SERVER_METHODS.PERMISSIONS_APPROVAL,
        params: {
          reason: "temporary write access",
          permissions: { fileSystem: { write: ["/workspace"] } },
        },
        decision: APPROVAL_DECISIONS.ALLOW_ONCE,
        expectedResponse: {
          permissions: { fileSystem: { write: ["/workspace"] } },
          scope: "turn",
        },
      },
      {
        id: 16,
        method: CODEX_APP_SERVER_METHODS.PERMISSIONS_APPROVAL,
        params: {
          reason: "denied temporary write access",
          permissions: { fileSystem: { write: ["/workspace"] } },
        },
        decision: APPROVAL_DECISIONS.DENY,
        expectedResponse: { permissions: {}, scope: "turn" },
      },
    ];

    const observations = requests.map((request) => channel.observe(request));
    assert.deepStrictEqual(
      observations.map((items) => items[0]?.kind),
      [
        HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
        HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
        HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
        HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
        HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
        HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
      ]
    );

    const starting = channel.start(writer);
    await settlePendingRequest(channel, writer, 0, {});
    await waitForWriteCount(writer, 3);
    await settlePendingRequest(channel, writer, 2, {
      thread: { id: "thread-approval" },
    });
    await starting;

    for (const [index, request] of requests.entries()) {
      const observation = observations[index][0];
      if (
        observation?.kind !==
        HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST
      ) {
        throw new Error("Expected an approval observation");
      }
      await channel.answerApproval(
        observation.requestId,
        request.decision,
        "ctrlyoke denied this request"
      );
      const response = writer.read(writer.writes.length - 1);
      assert.strictEqual(response.id, request.id);
      assert.deepStrictEqual(response.result, request.expectedResponse);
    }
    channel.close();
  });
});
