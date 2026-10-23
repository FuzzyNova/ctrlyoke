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
    const drain = await follower.drainToEof(50);
    assert.strictEqual(calls, 1);
    assert.strictEqual(drain.events.length, 1);
    assert.strictEqual(drain.events[0].subagent?.parentToolCallId, "spawn");
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
