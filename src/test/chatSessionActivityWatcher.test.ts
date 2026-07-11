import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ChatSessionActivityWatcher } from "../core/harness/chat/ChatSessionActivityWatcher";
import {
  ChatSessionParser,
  RESPONSE_MODEL_STATE,
} from "../core/harness/chat/ChatSessionParser";
import { CLI_EVENT_TYPES } from "../types/DashboardConstants";
import type { CliEvent } from "../types/CliOutputTypes";

suite("ChatSessionActivityWatcher Tests", () => {
  let tempDir: string;
  let sessionFile: string;
  let watcher: ChatSessionActivityWatcher;
  let received: CliEvent[][];

  const POLL_INTERVAL_MS = 30;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-watcher-test-"));
    sessionFile = path.join(tempDir, "session.json");
    received = [];
    watcher = new ChatSessionActivityWatcher({
      parser: new ChatSessionParser(),
      onResumedEvents: (events) => received.push(events),
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  });

  teardown(() => {
    watcher.stop();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeSession(requests: any[]): void {
    fs.writeFileSync(
      sessionFile,
      JSON.stringify(
        {
          version: 3,
          sessionId: "watcher-test",
          requests,
          creationDate: Date.now(),
          lastMessageDate: Date.now(),
        },
        null,
        2
      )
    );
  }

  function completeRequest(text: string, extra: Record<string, any> = {}) {
    return {
      requestId: `req-${text}`,
      message: { text },
      response: [{ value: `Reply to: ${text}` }],
      modelId: "copilot/claude-sonnet-4.5",
      modelState: { value: RESPONSE_MODEL_STATE.COMPLETE },
      result: { timings: { totalElapsed: 1000 } },
      ...extra,
    };
  }

  async function waitForPolls(count = 3): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, POLL_INTERVAL_MS * count)
    );
  }

  test("activate() picks up a new isSystemInitiated resume request as resumed events", async () => {
    writeSession([completeRequest("Follow instructions in prompt.md")]);
    watcher.activate(sessionFile, 0);

    // Simulate VS Code appending the auto-resume after the background task finishes.
    writeSession([
      completeRequest("Follow instructions in prompt.md"),
      { ...completeRequest("[Terminal notification: completed.]"), isSystemInitiated: true },
    ]);

    await waitForPolls();

    const allEvents = received.flat();
    assert.ok(
      allEvents.some(
        (e) => (e.data as any).text === "Reply to: [Terminal notification: completed.]"
      )
    );
    assert.ok(!allEvents.some((e) => e.type === CLI_EVENT_TYPES.USER_STEER));
  });

  test("activate() surfaces a genuine follow-up typed after completion as a user-steer event", async () => {
    writeSession([completeRequest("Follow instructions in prompt.md")]);
    watcher.activate(sessionFile, 0);

    writeSession([
      completeRequest("Follow instructions in prompt.md"),
      completeRequest("one more thing"),
    ]);

    await waitForPolls();

    const allEvents = received.flat();
    const steerEvent = allEvents.find(
      (e) => e.type === CLI_EVENT_TYPES.USER_STEER
    );
    assert.ok(steerEvent);
    assert.strictEqual((steerEvent!.data as any).text, "one more thing");
  });

  test("pause() stops further processing until activate() is called again", async () => {
    writeSession([completeRequest("Follow instructions in prompt.md")]);
    watcher.activate(sessionFile, 0);
    watcher.pause();

    writeSession([
      completeRequest("Follow instructions in prompt.md"),
      completeRequest("should not be seen while paused"),
    ]);

    await waitForPolls();
    assert.strictEqual(received.length, 0);

    // Re-activating re-seeds from index 1 (the current last index at pause
    // time is stale here — simulate the real flow where the owning send
    // re-seeds to whatever it just finished processing).
    watcher.activate(sessionFile, 1);
    writeSession([
      completeRequest("Follow instructions in prompt.md"),
      completeRequest("should not be seen while paused"),
      completeRequest("now visible after reactivation"),
    ]);
    await waitForPolls();

    const allEvents = received.flat();
    assert.ok(
      allEvents.some(
        (e) => (e.data as any).text === "now visible after reactivation"
      )
    );
    assert.ok(
      !allEvents.some(
        (e) => (e.data as any).text === "should not be seen while paused"
      )
    );
  });

  test("stop() halts polling entirely", async () => {
    writeSession([completeRequest("Follow instructions in prompt.md")]);
    watcher.activate(sessionFile, 0);
    watcher.stop();

    writeSession([
      completeRequest("Follow instructions in prompt.md"),
      completeRequest("should never be seen"),
    ]);

    await waitForPolls();
    assert.strictEqual(received.length, 0);
  });
});
