import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { OpenCodeLogParser } from "../../core/harness/opencode/OpenCodeLogParser";
import { OPENCODE_V2_MESSAGE_TYPES } from "../../core/harness/opencode/OpenCodeProtocolConstants";
import type { BaseCliEvent } from "../../core/harness/shared/interfaces/ILogParser";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";

/**
 * Real OpenCode 2.2.5 interactive (TUI) captures, driven through node-pty
 * (workspace and home paths replaced):
 *
 * - `v2-interactive-background-export.json`: two background shells (15 s and
 *   30 s) and a background subagent, launched in one turn (after a first
 *   subagent call that failed validation). Each job's `synthetic` notice
 *   starts its own resumed execution, closed by its own `idle`.
 * - `v2-interactive-background-midturn-export.json`: a background shell that
 *   finishes while a foreground shell keeps the launching execution running.
 *   Its notice joins that execution, so one `idle` closes both.
 */
const FIXTURE_ROOT = path.resolve(
  __dirname,
  "../../../src/test/fixtures/opencode"
);

interface ExportFixture {
  info: { id: string };
  messages: Array<{ id: string; type: string; [key: string]: unknown }>;
}

function readExport(name: string): ExportFixture {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, name), "utf8")
  ) as ExportFixture;
}

/**
 * Replays an export the way interactive polling sees it: each `poll()`
 * exposes the transcript up to a message count and feeds the new events
 * through `trackBackgroundWorkState`, as `CliLogEventPump` does.
 */
class ExportReplay {
  readonly parser: OpenCodeLogParser;
  private visible = 0;
  /** How much of each child's transcript is visible; all of it by default. */
  readonly childVisible = new Map<string, number>();
  /** Export calls per session id. */
  readonly exportCalls = new Map<string, number>();

  constructor(
    private readonly fixture: ExportFixture,
    private readonly children: readonly ExportFixture[] = []
  ) {
    this.parser = new OpenCodeLogParser(
      () => undefined,
      async (sessionId) => {
        this.exportCalls.set(
          sessionId,
          (this.exportCalls.get(sessionId) ?? 0) + 1
        );
        if (sessionId === fixture.info.id) {
          return JSON.stringify({
            info: fixture.info,
            messages: fixture.messages.slice(0, this.visible),
          });
        }
        const child = this.children.find((c) => c.info.id === sessionId);
        if (!child) throw new Error(`Session not found: ${sessionId}`);
        return JSON.stringify({
          info: child.info,
          messages: child.messages.slice(
            0,
            this.childVisible.get(sessionId) ?? Number.MAX_SAFE_INTEGER
          ),
        });
      }
    );
  }

  /** Index just past the `n`th (1-based) message of `type` in a child. */
  childThrough(childId: string, type: string, n: number): number {
    const child = this.children.find((c) => c.info.id === childId);
    assert.ok(child, `no child fixture ${childId}`);
    return replayIndexOf(child, type, n);
  }

  /** Index just past the `n`th (1-based) message of `type`. */
  through(type: string, n: number): number {
    return replayIndexOf(this.fixture, type, n);
  }

  async poll(messageCount: number): Promise<BaseCliEvent[]> {
    this.visible = messageCount;
    const events = await this.parser.readNewLines(this.fixture.info.id);
    for (const event of events) this.parser.trackBackgroundWorkState(event);
    return events;
  }
}

/** Index just past the `n`th (1-based) message of `type` in `fixture`. */
function replayIndexOf(
  fixture: ExportFixture,
  type: string,
  n: number
): number {
  let seen = 0;
  const index = fixture.messages.findIndex(
    (message) => message.type === type && ++seen === n
  );
  assert.ok(index >= 0, `fixture has ${n} ${type} messages`);
  return index + 1;
}

const IDLE = OPENCODE_V2_MESSAGE_TYPES.IDLE;
const SYNTHETIC = OPENCODE_V2_MESSAGE_TYPES.SYNTHETIC;

suite("OpenCodeLogParser background work (OpenCode 2)", () => {
  test("holds a Stop until every background job's resumed turn ends", async () => {
    const replay = new ExportReplay(
      readExport("v2-interactive-background-export.json")
    );
    const { parser } = replay;

    // First Stop: the launching execution is idle with all three running.
    await replay.poll(replay.through(IDLE, 1));
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);
    const held = parser.getBackgroundWorkHoldSnapshot();
    assert.strictEqual(held.awaitingResumedTurn, false);
    assert.deepStrictEqual(
      held.pendingTasks.map((task) => [
        task.toolName,
        task.command ?? task.description,
      ]),
      [
        ["shell", "ping -n 16 127.0.0.1"],
        ["shell", "ping -n 31 127.0.0.1"],
        // The first subagent call failed validation and launched nothing.
        ["subagent", "Ping test subagent"],
      ]
    );
    assert.match(held.pendingTasks[0].taskId ?? "", /^sh_/);
    assert.match(held.pendingTasks[2].taskId ?? "", /^ses_/);

    // A notice has arrived but its resumed turn has not ended yet.
    await replay.poll(replay.through(SYNTHETIC, 1));
    assert.strictEqual(
      parser.getBackgroundWorkHoldSnapshot().awaitingResumedTurn,
      true
    );
    assert.strictEqual(
      parser.getBackgroundWorkHoldSnapshot().pendingTasks.length,
      2
    );

    // Each resumed turn's Stop is still held while other jobs run.
    await replay.poll(replay.through(IDLE, 2));
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);
    await replay.poll(replay.through(IDLE, 3));
    assert.deepStrictEqual(
      parser.getBackgroundWorkHoldSnapshot().pendingTasks.map((t) => t.command),
      ["ping -n 31 127.0.0.1"]
    );

    // The last job's resumed turn ends: the final Stop completes the step.
    await replay.poll(replay.through(SYNTHETIC, 3));
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);
    await replay.poll(replay.through(IDLE, 4));
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);
  });

  test("a notice delivered into the running execution closes at its idle", async () => {
    const replay = new ExportReplay(
      readExport("v2-interactive-background-midturn-export.json")
    );
    const { parser } = replay;

    // The launching step finished, the foreground shell is still running.
    await replay.poll(2);
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);

    await replay.poll(replay.through(SYNTHETIC, 1));
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);
    assert.strictEqual(
      parser.getBackgroundWorkHoldSnapshot().awaitingResumedTurn,
      true
    );

    await replay.poll(replay.through(IDLE, 1));
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);
  });

  test("lifecycle events are resume signals with no output of their own", async () => {
    const replay = new ExportReplay(
      readExport("v2-interactive-background-export.json")
    );
    const events = await replay.poll(Number.MAX_SAFE_INTEGER);
    const { parser } = replay;

    const notices = events.filter(
      (event) => parser.classifyUserEvent(event, {}) === "resume-signal"
    );
    assert.strictEqual(notices.length, 3);
    for (const notice of notices) {
      assert.deepStrictEqual(
        parser.extractStructuredEventsFromEvent(notice),
        []
      );
    }

    const output = parser.extractResponse(events);
    const texts = output.events
      .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
      .map((event) => (event.data as { text: string }).text);
    assert.match(texts.at(-1) ?? "", /ALL DONE/);
  });

  test("a new monitored turn clears background state left by the last", async () => {
    const replay = new ExportReplay(
      readExport("v2-interactive-background-export.json")
    );
    await replay.poll(replay.through(IDLE, 1));
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), true);

    await replay.parser.beginMonitoringTurn();
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), false);
  });

  test("ignores synthetic messages that name no background job", async () => {
    const parser = new OpenCodeLogParser(
      () => undefined,
      async () =>
        JSON.stringify({
          info: { id: "ses_plan" },
          messages: [
            {
              id: "msg_plan",
              type: SYNTHETIC,
              time: { created: 1 },
              text: "Plan mode is active.",
              metadata: { source: "plan" },
            },
          ],
        })
    );
    assert.deepStrictEqual(await parser.readNewLines("ses_plan"), []);
  });

  test("tracks an image job by its jobID", async () => {
    const replay = new ExportReplay({
      info: { id: "ses_image" },
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: 1, completed: 2 },
          finish: "stop",
          content: [
            {
              type: "tool",
              id: "call_img",
              name: "experimental_image_generate",
              state: {
                status: "completed",
                input: { prompt: "a red square", file: "square" },
                content: [{ type: "text", text: "Image job job_1 started" }],
                metadata: { path: "square", model: "m", jobID: "job_1" },
              },
            },
          ],
        },
        { id: "msg_idle1", type: IDLE, time: { created: 3 } },
        {
          id: "msg_notice",
          type: SYNTHETIC,
          time: { created: 4 },
          text: "<image ...>",
          metadata: {
            source: "experimental_image_generate",
            jobID: "job_1",
            state: "completed",
          },
        },
        { id: "msg_idle2", type: IDLE, time: { created: 5 } },
      ],
    });

    await replay.poll(2);
    assert.deepStrictEqual(
      replay.parser.getBackgroundWorkHoldSnapshot().pendingTasks,
      [
        {
          toolName: "experimental_image_generate",
          description: "a red square",
          taskId: "job_1",
        },
      ]
    );
    await replay.poll(4);
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), false);
  });
});

/**
 * `v2-interactive-subagent-{parent,child}-export.json`: a real 2.2.5 TUI
 * capture. The parent calls a foreground subagent; the child starts a
 * background shell and ends its turn, so its job (and the parent's subagent
 * call) finishes and the parent replies and goes idle. 30 s later the shell's
 * notice wakes the child for a second execution that the parent never hears
 * about.
 */
suite("OpenCodeLogParser subagent child sessions (OpenCode 2)", () => {
  const parentFixture = readExport(
    "v2-interactive-subagent-parent-export.json"
  );
  const childFixture = readExport("v2-interactive-subagent-child-export.json");
  const childId = childFixture.info.id;
  const newReplay = () => new ExportReplay(parentFixture, [childFixture]);

  test("the capture names the child from the parent's subagent call", () => {
    const call = parentFixture.messages
      .flatMap((message) => (message.content as any[] | undefined) ?? [])
      .find((item) => item.name === "subagent");
    assert.strictEqual(call?.state?.metadata?.sessionID, childId);
    assert.strictEqual(call?.state?.metadata?.status, "completed");
  });

  test("holds the parent's Stop until the child's own background work ends", async () => {
    const replay = newReplay();
    const { parser } = replay;

    // The parent is idle, the child has gone idle with its shell running.
    replay.childVisible.set(childId, replay.childThrough(childId, IDLE, 1));
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);
    const held = parser.getBackgroundWorkHoldSnapshot();
    assert.deepStrictEqual(
      held.pendingTasks.map((task) => [task.toolName, task.command]),
      [["shell", "ping -n 31 127.0.0.1"]]
    );

    // The shell's notice has woken the child; its execution is still open.
    replay.childVisible.set(
      childId,
      replay.childThrough(childId, SYNTHETIC, 1)
    );
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);
    assert.strictEqual(
      parser.getBackgroundWorkHoldSnapshot().awaitingResumedTurn,
      true
    );

    // The child's second execution ends: nothing holds the step any more.
    replay.childVisible.delete(childId);
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);
  });

  test("reads a child the parent names in the same poll as its Stop", async () => {
    // No earlier poll saw the subagent call: the catch-up read before the
    // completion check must still find the child's running shell.
    const replay = newReplay();
    replay.childVisible.set(childId, replay.childThrough(childId, IDLE, 1));
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(replay.exportCalls.get(childId), 1);
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), true);
  });

  test("a child caught mid-execution holds the step and is named", async () => {
    const replay = newReplay();
    replay.childVisible.set(childId, 1); // only its prompt so far
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), true);
    assert.deepStrictEqual(
      replay.parser.getBackgroundWorkHoldSnapshot().pendingTasks,
      [
        {
          toolName: "subagent",
          taskId: childId,
          description: "Child background ping",
        },
      ]
    );
  });

  test("stops reading a child once nothing can wake it", async () => {
    const replay = newReplay();
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), false);
    const calls = replay.exportCalls.get(childId);
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(replay.exportCalls.get(childId), calls);
  });

  test("child lifecycle never reaches the parent's output or user events", async () => {
    const replay = newReplay();
    const events = await replay.poll(Number.MAX_SAFE_INTEGER);
    const { parser } = replay;
    const texts = parser
      .extractResponse(events)
      .events.filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
      .map((event) => (event.data as { text: string }).text);
    assert.deepStrictEqual(texts, ["PARENT-DONE"]);
    for (const event of events) {
      assert.notStrictEqual(
        parser.classifyUserEvent(event, {}),
        "resume-signal",
        `${event.type} must not resume the parent`
      );
    }
  });

  test("follows a nested subagent the child starts", async () => {
    const grandchildId = "ses_grandchild";
    const subagentCall = (sessionID: string) => ({
      type: "tool",
      id: `call_${sessionID}`,
      name: "subagent",
      state: {
        status: "completed",
        input: { agent: "general", description: `spawn ${sessionID}` },
        content: [{ type: "text", text: "done" }],
        metadata: { sessionID, status: "completed" },
      },
    });
    const parent: ExportFixture = {
      info: { id: "ses_parent" },
      messages: [
        {
          id: "msg_p1",
          type: "assistant",
          time: { created: 1, completed: 2 },
          finish: "stop",
          content: [subagentCall("ses_child")],
        },
        { id: "msg_p2", type: IDLE, time: { created: 3 } },
      ],
    };
    const child: ExportFixture = {
      info: { id: "ses_child" },
      messages: [
        {
          id: "msg_c1",
          type: "assistant",
          time: { created: 1, completed: 2 },
          finish: "stop",
          content: [subagentCall(grandchildId)],
        },
        { id: "msg_c2", type: IDLE, time: { created: 3 } },
      ],
    };
    const grandchild: ExportFixture = {
      info: { id: grandchildId },
      messages: [{ id: "msg_g1", type: "user", time: { created: 1 } }],
    };
    const replay = new ExportReplay(parent, [child, grandchild]);
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(replay.exportCalls.get(grandchildId), 1);
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), true);

    grandchild.messages.push({ id: "msg_g2", type: IDLE });
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), false);
  });

  test("a new monitored turn forgets the last turn's children", async () => {
    const replay = newReplay();
    replay.childVisible.set(childId, replay.childThrough(childId, IDLE, 1));
    await replay.poll(Number.MAX_SAFE_INTEGER);
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), true);
    await replay.parser.beginMonitoringTurn();
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), false);
  });
});

/**
 * The child's text reaches the output through the plugin's subagent sidecar,
 * not the export. These tests write the sidecar by hand, in the record shapes
 * the plugin appends, beside the same real export capture.
 */
suite("OpenCodeLogParser subagent follow-up output (OpenCode 2)", () => {
  const parentFixture = readExport(
    "v2-interactive-subagent-parent-export.json"
  );
  const childFixture = readExport("v2-interactive-subagent-child-export.json");
  const parentId = parentFixture.info.id;
  const childId = childFixture.info.id;
  const RUN_ID = "run-follow-up";
  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-oc-sidecar-"));
  });
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const append = (...records: object[]): void =>
    fs.appendFileSync(
      path.join(dir, `${RUN_ID}-subagents.jsonl`),
      records.map((record) => `${JSON.stringify(record)}\n`).join("")
    );
  const childText = (id: string, text: string) => ({
    kind: "part",
    childSessionId: childId,
    part: { type: "text", id, sessionID: childId, messageID: id, text },
  });
  const childIdle = { kind: "child-idle", childSessionId: childId };
  const callReturned = {
    kind: "task-running",
    childSessionId: childId,
    part: {
      type: "tool",
      id: "tool:call",
      sessionID: parentId,
      messageID: "msg_parent",
      callID: "call",
      tool: "subagent",
      state: { status: "completed", metadata: { sessionId: childId } },
    },
  };

  /** Replay that also registers spawns with the follower, as the pump does. */
  function startReplay(child: ExportFixture = childFixture): {
    replay: ExportReplay;
    streamed: string[];
    poll: () => Promise<void>;
  } {
    const replay = new ExportReplay(parentFixture, [child]);
    replay.parser.setSubagentSidecar(dir, RUN_ID);
    const streamed: string[] = [];
    replay.parser.getSubagentFollower().start((events) => {
      for (const event of events) {
        if (event.type === CLI_EVENT_TYPES.TEXT && event.subagent) {
          streamed.push((event.data as { text: string }).text);
        }
      }
    }, 5);
    return {
      replay,
      streamed,
      poll: async () => {
        const events = await replay.poll(Number.MAX_SAFE_INTEGER);
        for (const event of events) {
          replay.parser.extractStructuredEventsFromEvent(event);
        }
      },
    };
  }

  /** Let the follower's interval poll catch up with the sidecar. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  async function assertFollowUpShown(
    replay: ExportReplay,
    streamed: string[]
  ): Promise<void> {
    await settle();
    assert.deepStrictEqual(streamed, ["LAUNCHED", "CHILD-DONE"]);
    const drain = await replay.parser
      .getSubagentFollower()
      .drainToEof(500, { retainUnfinished: true });
    assert.strictEqual(drain.partial, false, "the child ended, not timed out");
  }

  test("keeps the child's output flowing when the export sees its job first", async () => {
    const { replay, streamed, poll } = startReplay();
    // The export tracker has the child's running shell before the sidecar's
    // idle is read, so that idle does not end the child.
    replay.childVisible.set(childId, replay.childThrough(childId, IDLE, 1));
    await poll();
    append(childText("m1", "LAUNCHED"), childIdle, callReturned);
    await settle();

    append(childText("m2", "CHILD-DONE"), childIdle);
    replay.childVisible.delete(childId);
    await poll();
    await assertFollowUpShown(replay, streamed);
  });

  test("reopens a child the sidecar already ended when its job's notice arrives", async () => {
    const { replay, streamed, poll } = startReplay();
    // The sidecar is read first: nothing is known to hold the child yet, so
    // its first idle ends it.
    append(childText("m1", "LAUNCHED"), childIdle, callReturned);
    replay.childVisible.set(childId, 0);
    await poll();
    await settle();

    // The notice wakes the child: its output must be followed again.
    replay.childVisible.set(
      childId,
      replay.childThrough(childId, SYNTHETIC, 1)
    );
    await poll();
    append(childText("m2", "CHILD-DONE"), childIdle);
    replay.childVisible.delete(childId);
    await poll();
    await assertFollowUpShown(replay, streamed);
  });

  test("shows a child's tool call once, when it finishes", async () => {
    const { replay, poll } = startReplay();
    const commands: string[] = [];
    replay.parser.getSubagentFollower().start((events) => {
      for (const event of events) {
        if (event.subagent && event.type !== CLI_EVENT_TYPES.TEXT) {
          commands.push(event.type);
        }
      }
    }, 5);
    const shellPart = (status: string) => ({
      kind: "part",
      childSessionId: childId,
      part: {
        type: "tool",
        id: "tool:call_shell",
        sessionID: childId,
        messageID: "m1",
        callID: "call_shell",
        tool: "shell",
        state: { status, input: { command: "ping -n 31 127.0.0.1" } },
      },
    });
    append(shellPart("running"), shellPart("completed"), callReturned);
    await poll();
    await settle();
    assert.strictEqual(commands.length, 1, JSON.stringify(commands));
  });

  test("a child with no background work ends at its idle as before", async () => {
    // The same child without its shell: one execution, ended by one idle.
    const plain: ExportFixture = {
      info: childFixture.info,
      messages: childFixture.messages
        .slice(0, replayIndexOf(childFixture, IDLE, 1))
        .filter(
          (message) =>
            !(message.content as any[] | undefined)?.some(
              (item) => item.name === "shell"
            )
        ),
    };
    const { replay, streamed, poll } = startReplay(plain);
    append(childText("m1", "LAUNCHED"), childIdle, callReturned);
    await poll();
    await settle();
    assert.deepStrictEqual(streamed, ["LAUNCHED"]);
    assert.strictEqual(replay.parser.hasPendingBackgroundWork(), false);
    const drain = await replay.parser
      .getSubagentFollower()
      .drainToEof(500, { retainUnfinished: true });
    assert.strictEqual(drain.partial, false);
  });
});
