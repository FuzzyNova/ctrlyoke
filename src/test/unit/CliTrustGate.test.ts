import * as assert from "assert";
import { suite, test } from "mocha";
import {
  askOnceForAll,
  ensureCliTrustDecided,
  type CliTrustRequest,
} from "../../cli/CliTrustGate";
import { RecordingCliTrustIo } from "../helpers/RecordingCliTrustIo";

function rootsRequest(
  items: readonly string[],
  recorded: boolean[]
): CliTrustRequest {
  return {
    heading: "This workspace requests external file roots:",
    items,
    reviewCommand: "ctrlyoke trust-external-roots",
    ask: askOnceForAll(
      `Trust all ${items.length} listed folder(s)?`,
      async (allow) => {
        recorded.push(allow);
      }
    ),
  };
}

suite("CliTrustGate", () => {
  test("proceeds silently when nothing is pending", async () => {
    const io = new RecordingCliTrustIo(false);
    const recorded: boolean[] = [];
    const result = await ensureCliTrustDecided(rootsRequest([], recorded), io);
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(io.err, []);
    assert.deepStrictEqual(recorded, []);
  });

  test("fails closed with exit code 2 and names the review command when it cannot ask", async () => {
    const io = new RecordingCliTrustIo(false);
    const recorded: boolean[] = [];
    const result = await ensureCliTrustDecided(
      rootsRequest(["C:/shared"], recorded),
      io
    );
    assert.strictEqual(result, 2);
    assert.ok(io.err.some((line) => line.includes("C:/shared")));
    assert.ok(
      io.err.some((line) => line.includes("`ctrlyoke trust-external-roots`"))
    );
    assert.deepStrictEqual(io.questions, []);
    assert.deepStrictEqual(recorded, []);
  });

  for (const answer of [true, false]) {
    test(`asks once in a terminal, records ${answer ? "allow" : "deny"}, and continues`, async () => {
      const io = new RecordingCliTrustIo(true, [answer]);
      const recorded: boolean[] = [];
      const result = await ensureCliTrustDecided(
        rootsRequest(["C:/shared", "D:/data"], recorded),
        io
      );
      assert.strictEqual(result, undefined);
      assert.deepStrictEqual(io.questions, [
        "Trust all 2 listed folder(s)? [y/N] ",
      ]);
      assert.deepStrictEqual(recorded, [answer]);
      assert.ok(io.err.some((line) => line.includes("D:/data")));
    });
  }
});
