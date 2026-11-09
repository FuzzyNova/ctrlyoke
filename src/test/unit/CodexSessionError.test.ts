import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { CodexLogParser } from "../../core/harness/codex/CodexLogParser";
import type { BaseCliEvent } from "../../core/harness/shared/interfaces/ILogParser";

const FIXTURE = path.resolve(
  __dirname,
  "../../../src/test/fixtures/harness-errors/codex/interactive-rollout-task-error.jsonl"
);

suite("Codex session errors", () => {
  test("fails on a captured rollout task_complete error without a grace period", () => {
    const parser = new CodexLogParser();
    const records = fs
      .readFileSync(FIXTURE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as BaseCliEvent);

    assert.deepStrictEqual(
      records.map((record) => parser.getSessionError(record)),
      [
        undefined,
        {
          message:
            "unexpected status 401 Unauthorized: stub: Incorrect API key provided, url: http://127.0.0.1:18403/v1/responses",
        },
      ]
    );
  });

  test("ignores a task_complete without an error", () => {
    const parser = new CodexLogParser();
    assert.strictEqual(
      parser.getSessionError({
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "done" },
      }),
      undefined
    );
  });
});
