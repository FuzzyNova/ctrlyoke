import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
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

  constructor(private readonly fixture: ExportFixture) {
    this.parser = new OpenCodeLogParser(
      () => undefined,
      async () =>
        JSON.stringify({
          info: fixture.info,
          messages: fixture.messages.slice(0, this.visible),
        })
    );
  }

  /** Index just past the `n`th (1-based) message of `type`. */
  through(type: string, n: number): number {
    let seen = 0;
    const index = this.fixture.messages.findIndex(
      (message) => message.type === type && ++seen === n
    );
    assert.ok(index >= 0, `fixture has ${n} ${type} messages`);
    return index + 1;
  }

  async poll(messageCount: number): Promise<BaseCliEvent[]> {
    this.visible = messageCount;
    const events = await this.parser.readNewLines(this.fixture.info.id);
    for (const event of events) this.parser.trackBackgroundWorkState(event);
    return events;
  }
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
