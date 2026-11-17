import * as assert from "assert";
import { setup, suite, teardown, test } from "mocha";
import { OpenCodeHeadlessControlChannel } from "../../core/harness/opencode/OpenCodeHeadlessControlChannel";
import {
  OPENCODE_HEADLESS_CONTROL_ENV,
  OPENCODE_HEADLESS_CONTROL_EVENTS,
  OPENCODE_HEADLESS_CONTROL_ROUTES,
  OPENCODE_HEADLESS_PERMISSION_DECISIONS,
} from "../../core/harness/opencode/OpenCodeProtocolConstants";
import type {
  ControlObservation,
  ControlWriter,
} from "../../core/harness/shared/IHeadlessControlChannel";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
} from "../../types/DashboardConstants";

suite("OpenCodeHeadlessControlChannel", () => {
  let channel: OpenCodeHeadlessControlChannel | undefined;
  let baseUrl: string;
  let token: string;
  let observations: ControlObservation[];

  const request = (route: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(new URL(route, baseUrl), { ...init, headers });
  };

  const waitForApprovalObservation = async (): Promise<
    Extract<
      ControlObservation,
      { kind: typeof HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST }
    >
  > => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const observation = observations.find(
        (next) =>
          next.kind === HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST
      );
      if (
        observation?.kind ===
        HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST
      ) {
        return observation;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("OpenCode permission request was not observed");
  };

  const publishSessionEvent = async (
    type: string,
    sessionID: string
  ): Promise<void> => {
    const response = await request(
      OPENCODE_HEADLESS_CONTROL_ROUTES.SESSION_EVENT,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, sessionID }),
      }
    );
    assert.strictEqual(response.status, 204);
  };

  setup(async () => {
    channel = await OpenCodeHeadlessControlChannel.create();
    const env = channel.spawnShape.env!;
    baseUrl = env[OPENCODE_HEADLESS_CONTROL_ENV.URL]!;
    token = env[OPENCODE_HEADLESS_CONTROL_ENV.TOKEN]!;
    observations = [];
  });

  teardown(() => {
    channel?.close();
    channel = undefined;
  });

  test("binds to loopback and authenticates control requests", async () => {
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.match(token, /^[a-f0-9]{64}$/u);

    const response = await fetch(
      new URL(
        `${OPENCODE_HEADLESS_CONTROL_ROUTES.STEER}?sessionID=ses_test`,
        baseUrl
      )
    );
    assert.strictEqual(response.status, 401);
  });

  test("keeps the initial prompt on stdin and injects queued steers", async () => {
    const writes: string[] = [];
    let endCount = 0;
    const writer: ControlWriter = {
      write: async (text) => {
        writes.push(text);
      },
      end: async () => {
        endCount += 1;
      },
    };
    await channel!.start(writer, (next) => observations.push(...next));
    await channel!.sendUserMessage("initial prompt");
    assert.deepStrictEqual(writes, ["initial prompt"]);
    assert.strictEqual(endCount, 1);

    const sending = channel!.sendUserMessage("steer this turn");
    await publishSessionEvent(
      OPENCODE_HEADLESS_CONTROL_EVENTS.EXECUTION_STARTED,
      "ses_main"
    );
    const poll = request(
      `${OPENCODE_HEADLESS_CONTROL_ROUTES.STEER}?sessionID=ses_main`
    );
    const delivered = await (await poll).json();
    await sending;
    assert.strictEqual((delivered as { text: string }).text, "steer this turn");
    assert.match((delivered as { id: string }).id, /^[0-9a-f-]{36}$/u);

    await publishSessionEvent(
      OPENCODE_HEADLESS_CONTROL_EVENTS.EXECUTION_SUCCEEDED,
      "ses_main"
    );
    assert.deepStrictEqual(observations, [
      { kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END },
    ]);
    await assert.rejects(
      channel!.sendUserMessage("too late"),
      /session has already ended/u
    );
  });

  test("maps dashboard approvals to one-shot once or reject replies", async () => {
    await channel!.start(
      { write: async () => {}, end: async () => {} },
      (next) => observations.push(...next)
    );

    const approval = request(OPENCODE_HEADLESS_CONTROL_ROUTES.PERMISSION, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID: "ses_main",
        agent: "build",
        action: "shell",
        resources: { command: "node mark.js" },
        source: "model",
        effect: "ask",
      }),
    });
    const firstRequest = await waitForApprovalObservation();
    assert.strictEqual(firstRequest.toolName, "shell");
    await channel!.answerApproval(
      firstRequest.requestId,
      APPROVAL_DECISIONS.ALLOW_ONCE
    );
    assert.deepStrictEqual(await (await approval).json(), {
      decision: OPENCODE_HEADLESS_PERMISSION_DECISIONS.ONCE,
    });

    observations = [];
    const deniedApproval = request(
      OPENCODE_HEADLESS_CONTROL_ROUTES.PERMISSION,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "edit", effect: "ask" }),
      }
    );
    const secondRequest = await waitForApprovalObservation();
    await channel!.answerApproval(
      secondRequest.requestId,
      APPROVAL_DECISIONS.DENY,
      "ctrlyoke test denial"
    );
    assert.deepStrictEqual(await (await deniedApproval).json(), {
      decision: OPENCODE_HEADLESS_PERMISSION_DECISIONS.REJECT,
      message: "ctrlyoke test denial",
    });
  });
});
