import * as assert from "assert";
import { suite, test } from "mocha";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
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
    await settlePendingRequest(channel, writer, 3, {});
    await sending;

    assert.deepStrictEqual(
      channel.observe({
        method: CODEX_APP_SERVER_METHODS.TURN_COMPLETED,
        params: { threadId: "thread-new" },
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

  test("answers command, file-change, and permission requests with scoped decisions", async () => {
    const writer = new RecordingControlWriter();
    const channel = new CodexAppServerHeadlessControlChannel();
    const requests = [
      {
        id: 11,
        method: CODEX_APP_SERVER_METHODS.COMMAND_APPROVAL,
        params: { command: "node script.js" },
      },
      {
        id: 12,
        method: CODEX_APP_SERVER_METHODS.FILE_CHANGE_APPROVAL,
        params: { reason: "write outside the workspace" },
      },
      {
        id: 13,
        method: CODEX_APP_SERVER_METHODS.PERMISSIONS_APPROVAL,
        params: {
          reason: "temporary write access",
          permissions: { fileSystem: { write: ["/workspace"] } },
        },
      },
    ];

    const observations = requests.map((request) => channel.observe(request));
    assert.deepStrictEqual(
      observations.map((items) => items[0]?.kind),
      [
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
        index === 2 ? APPROVAL_DECISIONS.ALLOW_ONCE : APPROVAL_DECISIONS.DENY,
        "ctrlyoke denied this request"
      );
      const response = writer.read(writer.writes.length - 1);
      assert.strictEqual(response.id, request.id);
      if (index < 2) {
        assert.deepStrictEqual(response.result, { decision: "decline" });
      } else {
        assert.deepStrictEqual(response.result, {
          permissions: { fileSystem: { write: ["/workspace"] } },
          scope: "turn",
        });
      }
    }
    channel.close();
  });
});
