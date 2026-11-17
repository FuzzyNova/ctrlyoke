import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, test } from "mocha";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
} from "../../types/DashboardConstants";
import { CopilotHeadlessControlChannel } from "../../core/harness/copilot/CopilotHeadlessControlChannel";
import type { ControlWriter } from "../../core/harness/shared/IHeadlessControlChannel";
import type { AcpJsonRpcMessage } from "../../core/harness/shared/AcpJsonRpcClient";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

function createChannel(
  options: {
    sessionId?: string;
    imageFilePaths?: readonly string[];
    workspaceRoot?: string;
    onSessionId?: (sessionId: string) => void;
  } = {}
): CopilotHeadlessControlChannel {
  return new CopilotHeadlessControlChannel(
    {
      approvalPolicy: "deny",
      approvalTimeoutMs: 1_000,
      useApprovalControl: false,
      context: options,
    },
    ["--resume", "old-session", "--model", "test-model"]
  );
}

async function waitForWrite(
  writes: readonly string[],
  index: number
): Promise<AcpJsonRpcMessage> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (writes[index]) return JSON.parse(writes[index]) as AcpJsonRpcMessage;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ACP write ${index}`);
}

function createWriter(writes: string[]): ControlWriter {
  return {
    async write(text) {
      writes.push(text);
    },
    async end() {},
  };
}

async function startFreshSession(
  channel: CopilotHeadlessControlChannel,
  writes: string[]
): Promise<void> {
  const starting = channel.start(createWriter(writes));
  const initialize = await waitForWrite(writes, 0);
  assert.strictEqual(initialize.method, "initialize");
  channel.observeStdoutChunk(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: initialize.id,
      result: { protocolVersion: 1 },
    })}\n`
  );
  const sessionNew = await waitForWrite(writes, 1);
  assert.strictEqual(sessionNew.method, "session/new");
  channel.observeStdoutChunk(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: sessionNew.id,
      result: { sessionId: "copilot-session" },
    })}\n`
  );
  await starting;
}

suite("CopilotHeadlessControlChannel", () => {
  test("uses ACP session creation and queues prompts until the active response", async () => {
    const writes: string[] = [];
    let resolvedSessionId: string | undefined;
    const channel = createChannel({
      onSessionId: (sessionId) => (resolvedSessionId = sessionId),
    });

    assert.strictEqual(channel.steerDelivery, HEADLESS_STEER_DELIVERIES.QUEUE);
    assert.strictEqual(channel.startLogTailAfterChannelStart, true);
    assert.deepStrictEqual(channel.spawnShape, {
      args: ["--acp", "--model", "test-model"],
      replaceArgs: true,
    });

    const starting = channel.start(createWriter(writes));
    const initialize = await waitForWrite(writes, 0);
    const initializeParams = initialize.params as {
      clientCapabilities: { _meta: Record<string, unknown> };
    };
    assert.deepStrictEqual(
      initializeParams.clientCapabilities._meta[
        "github.com/copilot/sessionEvent"
      ],
      {
        events: ["assistant.turn_start", "assistant.idle", "session.idle"],
      }
    );
    channel.observeStdoutChunk(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: initialize.id,
        result: { protocolVersion: 1 },
      })}\n`
    );
    const sessionNew = await waitForWrite(writes, 1);
    const sessionParams = sessionNew.params as {
      cwd: string;
      mcpServers: unknown[];
    };
    assert.ok(sessionParams.cwd);
    assert.deepStrictEqual(sessionParams.mcpServers, []);
    channel.observeStdoutChunk(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: sessionNew.id,
        result: { sessionId: "copilot-session" },
      })}\n`
    );
    await starting;
    assert.strictEqual(resolvedSessionId, "copilot-session");

    await channel.sendUserMessage("first");
    const firstPrompt = await waitForWrite(writes, 2);
    assert.strictEqual(firstPrompt.method, "session/prompt");
    assert.deepStrictEqual(
      (firstPrompt.params as { prompt: unknown[] }).prompt,
      [{ type: "text", text: "first" }]
    );

    const queuedSteer = channel.sendUserMessage("steer");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(writes.length, 3);

    const boundary = channel.observeStdoutChunk(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: firstPrompt.id,
        result: { stopReason: "end_turn" },
      })}\n`
    );
    assert.deepStrictEqual(boundary, [
      { kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END },
    ]);
    await queuedSteer;
    const steerPrompt = await waitForWrite(writes, 3);
    assert.strictEqual(steerPrompt.method, "session/prompt");
    assert.deepStrictEqual(
      (steerPrompt.params as { prompt: unknown[] }).prompt,
      [{ type: "text", text: "steer" }]
    );
    channel.close();
  });

  test("maps approvals to one-shot ACP options only", async () => {
    const writes: string[] = [];
    const channel = createChannel();
    await startFreshSession(channel, writes);

    const allow = channel.observeStdoutChunk(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 41,
        method: "session/request_permission",
        params: {
          toolCall: { title: "shell", rawInput: { command: "echo ok" } },
          options: [
            { optionId: "always", kind: "allow_always" },
            { optionId: "once", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        },
      })}\n`
    );
    assert.deepStrictEqual(allow, [
      {
        kind: HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
        requestId: "number:41",
        toolName: "shell",
        input: { command: "echo ok" },
      },
    ]);
    await channel.answerApproval("number:41", APPROVAL_DECISIONS.ALLOW_ONCE);
    assert.deepStrictEqual(JSON.parse(writes.at(-1)!), {
      jsonrpc: "2.0",
      id: 41,
      result: { outcome: { outcome: "selected", optionId: "once" } },
    });

    channel.observeStdoutChunk(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "approval-deny",
        method: "session/request_permission",
        params: {
          toolCall: { title: "shell", rawInput: { command: "rm file" } },
          options: [
            { optionId: "always", kind: "allow_always" },
            { optionId: "reject", kind: "reject_once" },
          ],
        },
      })}\n`
    );
    await channel.answerApproval(
      "string:approval-deny",
      APPROVAL_DECISIONS.DENY
    );
    assert.deepStrictEqual(JSON.parse(writes.at(-1)!), {
      jsonrpc: "2.0",
      id: "approval-deny",
      result: { outcome: { outcome: "selected", optionId: "reject" } },
    });

    channel.observeStdoutChunk(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "approval-without-deny",
        method: "session/request_permission",
        params: {
          toolCall: { title: "shell", rawInput: { command: "rm file" } },
          options: [
            {
              optionId: "always",
              kind: "allow_always",
            },
          ],
        },
      })}\n`
    );
    await assert.rejects(
      channel.answerApproval(
        "string:approval-without-deny",
        APPROVAL_DECISIONS.DENY
      ),
      /no reject_once option/
    );
    assert.deepStrictEqual(JSON.parse(writes.at(-1)!), {
      jsonrpc: "2.0",
      id: "approval-without-deny",
      error: {
        code: -32602,
        message: "Copilot ACP approval request has no reject_once option",
      },
    });
    channel.close();
  });

  test("sends image attachments as ACP image content", async () => {
    const workspace = await makeTempDir("copilot-acp-image-");
    try {
      const imagePath = path.join(workspace, "pixel.png");
      await fs.writeFile(imagePath, Buffer.from("png-data"));
      const writes: string[] = [];
      const channel = createChannel({
        imageFilePaths: [imagePath],
        workspaceRoot: workspace,
      });
      await startFreshSession(channel, writes);
      await channel.sendUserMessage("Describe the image");

      const prompt = await waitForWrite(writes, 2);
      assert.deepStrictEqual((prompt.params as { prompt: unknown[] }).prompt, [
        { type: "text", text: "Describe the image" },
        {
          type: "image",
          data: Buffer.from("png-data").toString("base64"),
          mimeType: "image/png",
        },
      ]);
      channel.close();
    } finally {
      await removeTempDir(workspace);
    }
  });

  test("uses session/load for a resumed conversation", async () => {
    const writes: string[] = [];
    let resolvedSessionId: string | undefined;
    const channel = new CopilotHeadlessControlChannel(
      {
        approvalPolicy: "deny",
        approvalTimeoutMs: 1_000,
        useApprovalControl: false,
        context: {
          sessionId: "resume-me",
          workspaceRoot: "C:\\workspace",
          onSessionId: (sessionId) => (resolvedSessionId = sessionId),
        },
      },
      ["--resume", "resume-me"]
    );
    const starting = channel.start(createWriter(writes));
    const initialize = await waitForWrite(writes, 0);
    channel.observeStdoutChunk(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: initialize.id,
        result: { protocolVersion: 1 },
      })}\n`
    );
    const load = await waitForWrite(writes, 1);
    assert.strictEqual(load.method, "session/load");
    assert.deepStrictEqual(load.params, {
      sessionId: "resume-me",
      cwd: "C:\\workspace",
      mcpServers: [],
    });
    channel.observeStdoutChunk(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: load.id,
        result: {},
      })}\n`
    );
    await starting;
    assert.strictEqual(resolvedSessionId, "resume-me");
    channel.close();
  });
});
