import * as assert from "assert";
import { suite, test } from "mocha";
import type { CliEvent } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import { SubagentSourceFollower } from "../../core/harness/shared/SubagentSourceFollower";
import type { SubagentChildSource } from "../../core/harness/shared/interfaces/SubagentChildSource";

interface RecordItem {
  id: string;
  text: string;
  done?: boolean;
}

suite("SubagentSourceFollower", () => {
  test("streams growing source records and drains unread records", async () => {
    const follower = new SubagentSourceFollower();
    const live: CliEvent[] = [];
    const records: RecordItem[] = [{ id: "one", text: "first" }];
    const source: SubagentChildSource<RecordItem> = {
      key: "child",
      attribution: { parentToolCallId: "spawn" },
      read: async (offset) => ({
        records: records.slice(offset),
        nextOffset: records.length,
        complete: records.some((record) => record.done),
      }),
      map: (record) => [
        {
          type: CLI_EVENT_TYPES.TEXT,
          timestamp: Number(record.id === "one" ? 1 : 2),
          data: { text: record.text },
        },
      ],
      isComplete: (record) => record.done === true,
    };
    follower.register(source);
    follower.start((events) => live.push(...events), 50);
    await new Promise((resolve) => setTimeout(resolve, 5));
    records.push({ id: "two", text: "second", done: true });
    await new Promise((resolve) => setTimeout(resolve, 70));
    const drain = await follower.drainToEof(50);
    assert.deepStrictEqual(
      live
        .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
        .map((event) => (event.data as { text: string }).text),
      ["first", "second"]
    );
    assert.strictEqual(drain.events.length, 3);
    assert.strictEqual(drain.partial, false);
  });

  test("a reopened child streams what it writes after its completion record", async () => {
    const follower = new SubagentSourceFollower();
    const live: string[] = [];
    const records: RecordItem[] = [{ id: "one", text: "first", done: true }];
    follower.register<RecordItem>({
      key: "child",
      attribution: { parentToolCallId: "spawn", agentId: "agent-1" },
      read: async (offset) => ({
        records: records.slice(offset),
        nextOffset: records.length,
      }),
      map: (record) => [
        { type: CLI_EVENT_TYPES.TEXT, data: { text: record.text } },
      ],
      isComplete: (record) => record.done === true,
    });
    follower.start((events) => {
      for (const event of events) {
        if (event.type === CLI_EVENT_TYPES.TEXT) {
          live.push((event.data as { text: string }).text);
        }
      }
    }, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(follower.reopenChild("unknown"), false);

    // Written after the completion record: unread until the child reopens.
    records.push({ id: "two", text: "second" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepStrictEqual(live, ["first"]);

    assert.strictEqual(follower.reopenChild("agent-1"), true);
    assert.strictEqual(follower.reopenChild("agent-1"), false, "still open");
    records.push({ id: "three", text: "third", done: true });
    const drain = await follower.drainToEof(200);
    assert.deepStrictEqual(live, ["first", "second", "third"]);
    assert.strictEqual(drain.partial, false);
    // Each completion updates the spawn card, the reopened one included.
    assert.strictEqual(
      drain.events.filter((event) => event.type === CLI_EVENT_TYPES.TOOL_CALL)
        .length,
      2
    );
  });

  test("deduplicates reread records and ignores unregistered sources", async () => {
    const follower = new SubagentSourceFollower();
    let calls = 0;
    const source: SubagentChildSource<RecordItem> = {
      key: "known",
      attribution: { parentToolCallId: "spawn" },
      read: async () => {
        calls += 1;
        return {
          records: [{ id: "same", text: "once" }],
          nextOffset: 0,
          complete: calls > 1,
        };
      },
      map: (record) => [
        { type: CLI_EVENT_TYPES.TEXT, data: { text: record.text } },
      ],
      isComplete: () => false,
    };
    follower.register(source);
    // The deadline must outlast one poll interval so the second read always
    // happens; a 50ms deadline raced it and asserted on whichever won.
    const drain = await follower.drainToEof();
    assert.strictEqual(calls, 2);
    assert.strictEqual(drain.events.length, 1);
    assert.strictEqual(drain.events[0].subagent?.parentToolCallId, "spawn");
  });

  test("keeps an unfinished source streaming after a retaining drain", async () => {
    const follower = new SubagentSourceFollower();
    const records: RecordItem[] = [{ id: "one", text: "before completion" }];
    let reads = 0;
    follower.register<RecordItem>({
      key: "still-running",
      attribution: { parentToolCallId: "spawn" },
      read: async (offset) => {
        reads += 1;
        return { records: records.slice(offset), nextOffset: records.length };
      },
      map: (record) => [
        { type: CLI_EVENT_TYPES.TEXT, data: { text: record.text } },
      ],
      isComplete: (record) => record.done === true,
    });

    const first = await follower.drainToEof(50, { retainUnfinished: true });
    assert.strictEqual(first.events.length, 1);
    assert.strictEqual(first.partial, true);

    // Between prompts (SessionActivityWatcher) the child keeps streaming
    // from where the drain left off.
    const live: CliEvent[] = [];
    records.push({ id: "two", text: "after completion" });
    follower.start((events) => live.push(...events), 10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    follower.stop();
    assert.deepStrictEqual(
      live.map((event) => (event.data as { text: string }).text),
      ["after completion"]
    );
    assert.strictEqual(live[0].subagent?.parentToolCallId, "spawn");

    // The next prompt does not inherit that follow-up output, wait for the
    // carried child, or turn partial because of it.
    follower.beginTurn();
    const readsBefore = reads;
    const started = Date.now();
    const second = await follower.drainToEof(500, { retainUnfinished: true });
    assert.ok(Date.now() - started < 400, "drain waited for a carried child");
    assert.ok(reads > readsBefore);
    assert.strictEqual(second.events.length, 0);
    assert.strictEqual(second.partial, false);
  });

  test("streams spawn updates and suppresses them once the spawn completes", async () => {
    const follower = new SubagentSourceFollower();
    const live: CliEvent[] = [];
    follower.register<RecordItem>({
      key: "child",
      attribution: { parentToolCallId: "spawn", agentId: "agent-1" },
      read: async () => ({ records: [], nextOffset: 0 }),
      map: () => [],
      isComplete: () => false,
    });
    follower.start((events) => live.push(...events), 1000);
    follower.updateSpawn("spawn", {
      children: [{ agentId: "agent-1", label: "find:ui" }],
      state: "running",
    });
    follower.markChildComplete("agent-1");
    follower.updateSpawn("spawn", { state: "running" });
    const drain = await follower.drainToEof(50);
    const states = live.map(
      (event) =>
        (event.data as { subagentSpawn?: { state: string } }).subagentSpawn
          ?.state
    );
    assert.deepStrictEqual(states, ["running", "completed"]);
    assert.strictEqual(drain.events.length, 2);
    assert.strictEqual(drain.partial, false);
  });

  test("keeps streaming children registered after a reset", async () => {
    // Antigravity resets its follower when it first learns the session ID,
    // which is after the headless tail has started streaming.
    const follower = new SubagentSourceFollower();
    const live: CliEvent[] = [];
    follower.start((events) => live.push(...events), 10);
    follower.reset();
    follower.register<RecordItem>({
      key: "after-reset",
      attribution: { parentToolCallId: "spawn" },
      read: async () => ({
        records: [{ id: "one", text: "child output", done: true }],
        nextOffset: 1,
      }),
      map: (record) => [
        { type: CLI_EVENT_TYPES.TEXT, data: { text: record.text } },
      ],
      isComplete: (record) => record.done === true,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    follower.stop();
    assert.deepStrictEqual(
      live
        .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
        .map((event) => (event.data as { text: string }).text),
      ["child output"]
    );
  });

  test("streams records the final drain reads, then stops", async () => {
    // A headless run's history is its streamed output, so child output read
    // only by the final drain must still reach the streaming callback.
    const follower = new SubagentSourceFollower();
    const live: CliEvent[] = [];
    follower.start((events) => live.push(...events), 60_000);
    follower.register<RecordItem>({
      key: "late",
      attribution: { parentToolCallId: "spawn" },
      read: async () => ({
        records: [{ id: "one", text: "read by the drain", done: true }],
        nextOffset: 1,
      }),
      map: (record) => [
        { type: CLI_EVENT_TYPES.TEXT, data: { text: record.text } },
      ],
      isComplete: (record) => record.done === true,
    });
    const drain = await follower.drainToEof(500);
    const streamedText = live
      .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
      .map((event) => (event.data as { text: string }).text);
    assert.deepStrictEqual(streamedText, ["read by the drain"]);
    assert.ok(
      drain.events.some((event) => event.type === CLI_EVENT_TYPES.TEXT)
    );

    const countAfterDrain = live.length;
    follower.register<RecordItem>({
      key: "after-drain",
      attribution: { parentToolCallId: "other" },
      read: async () => ({
        records: [{ id: "two", text: "must not stream" }],
        nextOffset: 1,
      }),
      map: (record) => [
        { type: CLI_EVENT_TYPES.TEXT, data: { text: record.text } },
      ],
      isComplete: () => false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(live.length, countAfterDrain);
  });

  test("marks unreadable registered sources partial", async () => {
    const follower = new SubagentSourceFollower();
    follower.register({
      key: "unreadable",
      attribution: { parentToolCallId: "spawn" },
      read: async () => {
        throw new Error("read failed");
      },
      map: () => [],
      isComplete: () => false,
    });
    const drain = await follower.drainToEof(50);
    assert.strictEqual(drain.partial, true);
  });
});
