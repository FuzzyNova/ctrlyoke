import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { QwenLogParser } from "../../core/harness/qwen/QwenLogParser";
import type { BaseCliEvent } from "../../core/harness/shared/interfaces/ILogParser";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../src/test/fixtures/qwen");

function readFixture(name: string): BaseCliEvent[] {
  return fs
    .readFileSync(path.join(FIXTURE_ROOT, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as BaseCliEvent);
}

function functionCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {}
): BaseCliEvent {
  return {
    type: "assistant",
    message: { role: "model", parts: [{ functionCall: { id, name, args } }] },
  };
}

function toolResult(id: string, name: string, output: string): BaseCliEvent {
  return {
    type: "tool_result",
    message: {
      role: "user",
      parts: [{ functionResponse: { id, name, response: { output } } }],
    },
  };
}

function taskNotification(taskId: string, status: string): string {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>`;
}

/** Qwen stamps `deliveredTurn: true` on a sent turn and omits it otherwise. */
function notification(texts: string[], delivered = true): BaseCliEvent {
  return {
    type: "user",
    subtype: "notification",
    provenance: "system",
    ...(delivered ? { deliveredTurn: true } : {}),
    message: { role: "user", parts: texts.map((text) => ({ text })) },
  };
}

const TURN_END: BaseCliEvent = {
  type: "assistant",
  message: { role: "model", parts: [{ text: "Done for now." }] },
};

function track(parser: QwenLogParser, ...events: BaseCliEvent[]): void {
  for (const event of events) {
    parser.trackBackgroundWorkState(event);
  }
}

suite("QwenLogParser background work", () => {
  test("holds a real interactive capture until the last task's resumed turn ends", () => {
    const events = readFixture("interactive-background-shells.session.jsonl");
    const parser = new QwenLogParser();
    const turnEnds = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => parser.isComplete(event))
      .map(({ index }) => index);
    assert.strictEqual(turnEnds.length, 4, "launch turn + one per task");

    const pendingAfter = events.map((event) => {
      parser.trackBackgroundWorkState(event);
      return parser.hasPendingBackgroundWork();
    });

    // The launch turn and the first two resumed turns end while tasks remain.
    for (const index of turnEnds.slice(0, 3)) {
      assert.strictEqual(pendingAfter[index], true, `turn end #${index}`);
    }
    // Completion is released exactly at the final resumed turn's end.
    const lastTurnEnd = turnEnds[3];
    assert.strictEqual(pendingAfter.indexOf(false, turnEnds[0]), lastTurnEnd);
    assert.strictEqual(pendingAfter[pendingAfter.length - 1], false);
  });

  test("names each pending shell from its launching call", () => {
    const events = readFixture("interactive-background-shells.session.jsonl");
    const parser = new QwenLogParser();
    const firstTurnEnd = events.findIndex((event) => parser.isComplete(event));
    track(parser, ...events.slice(0, firstTurnEnd + 1));

    const snapshot = parser.getBackgroundWorkHoldSnapshot();
    assert.deepStrictEqual(
      snapshot.pendingTasks.map((task) => [task.taskId, task.toolName]),
      [
        ["bg_432af12a", "run_shell_command"],
        ["bg_f8bfeca0", "run_shell_command"],
        ["bg_dc65fe97", "run_shell_command"],
      ]
    );
    assert.match(
      snapshot.pendingTasks[2].command ?? "",
      /Start-Sleep -Seconds 30/
    );
    assert.ok(snapshot.pendingTasks[2].description);
    assert.strictEqual(snapshot.awaitingResumedTurn, false);
  });

  test("classifies task notifications as resume signals, not human steers", () => {
    const events = readFixture("interactive-background-shells.session.jsonl");
    const parser = new QwenLogParser();
    const userEvents = events.filter((event) => event.type === "user");
    const prompt = parser.extractUserSteerText(userEvents[0]);

    assert.deepStrictEqual(
      userEvents.map((event) =>
        parser.classifyUserEvent(event, { dispatchedPromptText: prompt })
      ),
      ["injected-prompt", "resume-signal", "resume-signal", "resume-signal"]
    );
  });

  test("classifies cron prompts and agent messages as non-human input", () => {
    const parser = new QwenLogParser();
    const text = { role: "user", parts: [{ text: "check the build" }] };

    assert.strictEqual(
      parser.classifyUserEvent(
        { type: "user", subtype: "cron", provenance: "system", message: text },
        {}
      ),
      "resume-signal"
    );
    assert.strictEqual(
      parser.classifyUserEvent(
        {
          type: "user",
          subtype: "agent_message",
          provenance: "external_agent",
          message: text,
        },
        {}
      ),
      "other"
    );
    assert.strictEqual(
      parser.classifyUserEvent(
        { type: "user", provenance: "real_user", message: text },
        { dispatchedPromptText: "something else" }
      ),
      "human-steer"
    );
  });

  test("tracks background agents and a backlog drained into one turn", () => {
    const parser = new QwenLogParser();
    track(
      parser,
      functionCall("call-agent", "agent", { description: "Audit the docs" }),
      toolResult(
        "call-agent",
        "agent",
        "Background agent launched successfully.\ntask_id: general-purpose-a1b2 (internal ID — do not mention to the user.)"
      ),
      functionCall("call-shell", "run_shell_command", { command: "npm test" }),
      toolResult(
        "call-shell",
        "run_shell_command",
        "Background shell started.\nid: bg_12345678\npid: 1"
      ),
      TURN_END
    );
    assert.deepStrictEqual(
      parser
        .getBackgroundWorkHoldSnapshot()
        .pendingTasks.map((task) => task.description ?? task.command),
      ["Audit the docs", "npm test"]
    );

    track(
      parser,
      notification([
        `${taskNotification("general-purpose-a1b2", "completed")}\n${taskNotification("bg_12345678", "failed")}`,
      ])
    );
    assert.strictEqual(
      parser.getBackgroundWorkHoldSnapshot().pendingTasks.length,
      0
    );
    assert.strictEqual(
      parser.hasPendingBackgroundWork(),
      true,
      "resumed turn open"
    );

    track(parser, TURN_END);
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);
  });

  test("keeps a monitor pending through running pulses until task_stop cancels it", () => {
    const parser = new QwenLogParser();
    track(
      parser,
      functionCall("call-monitor", "monitor", { command: "npm run watch" }),
      toolResult(
        "call-monitor",
        "monitor",
        "Monitor started.\nid: mon_1\ncommand: npm run watch"
      ),
      TURN_END,
      notification([taskNotification("mon_1", "running")]),
      TURN_END
    );
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);

    // Qwen cancels a monitor with notify: false, so no notification follows.
    track(
      parser,
      functionCall("call-stop", "task_stop", { task_id: "mon_1" }),
      toolResult(
        "call-stop",
        "task_stop",
        'Monitor "mon_1" cancelled. Status is visible via /tasks.'
      ),
      TURN_END
    );
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);
  });

  test("a stopped shell stays pending until its own terminal notification", () => {
    const parser = new QwenLogParser();
    track(
      parser,
      toolResult(
        "call-shell",
        "run_shell_command",
        "Background shell started.\nid: bg_aaaa\n"
      ),
      toolResult(
        "call-stop",
        "task_stop",
        'Cancellation requested for background shell "bg_aaaa".'
      ),
      TURN_END
    );
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);

    track(
      parser,
      notification([taskNotification("bg_aaaa", "cancelled")]),
      TURN_END
    );
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);
  });

  test("an undelivered notification copy clears its task without awaiting a turn", () => {
    const parser = new QwenLogParser();
    track(
      parser,
      toolResult(
        "call-shell",
        "run_shell_command",
        "Background shell started.\nid: bg_bbbb\n"
      ),
      TURN_END,
      notification([taskNotification("bg_bbbb", "completed")], false)
    );
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);

    // A later delivered copy of the same notification is a no-op.
    track(parser, notification([taskNotification("bg_bbbb", "completed")]));
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);
  });

  test("ignores failed launches and unrelated notifications", () => {
    const parser = new QwenLogParser();
    track(
      parser,
      {
        type: "tool_result",
        message: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-shell",
                name: "run_shell_command",
                response: { error: "Background shell started.\nid: bg_cccc" },
              },
            },
          ],
        },
      },
      notification([taskNotification("bg_unknown", "completed")]),
      TURN_END
    );
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);
  });

  test("resets background state at session discovery", async () => {
    const parser = new QwenLogParser();
    parser.setWorkspaceRoot(path.join(os.tmpdir(), "qwen-no-such-workspace"));
    track(
      parser,
      toolResult(
        "call-shell",
        "run_shell_command",
        "Background shell started.\nid: bg_dddd\n"
      )
    );
    assert.strictEqual(parser.hasPendingBackgroundWork(), true);

    await parser.discoverSessionLog("prompt", new Date());
    assert.strictEqual(parser.hasPendingBackgroundWork(), false);
  });
});

suite("QwenLogParser session discovery", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let testHome: string | undefined;

  teardown(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (testHome) {
      removeTempDir(testHome);
      testHome = undefined;
    }
  });

  test("discovers a resumed session in its original worktree project", async () => {
    testHome = makeTempDir("ctrlyoke-qwen-home-");
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;

    const sessionId = "qwen-session-from-original-worktree";
    const originalChatsDirectory = path.join(
      testHome,
      ".qwen",
      "projects",
      "c--dev-ctrlyoke-worktrees-bug-fix",
      "chats"
    );
    const sessionPath = path.join(originalChatsDirectory, `${sessionId}.jsonl`);
    fs.mkdirSync(originalChatsDirectory, { recursive: true });
    fs.writeFileSync(sessionPath, '{"type":"user"}\n', "utf8");

    const parser = new QwenLogParser();
    parser.setWorkspaceRoot(path.win32.join("C:\\", "dev", "ctrlyoke"));

    assert.strictEqual(
      await parser.discoverSessionLog(
        "prompt",
        new Date(Date.now() - 1_000),
        sessionId
      ),
      sessionPath
    );
  });
});
