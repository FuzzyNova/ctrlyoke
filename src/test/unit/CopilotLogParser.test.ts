import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { CopilotLogParser } from "../../core/harness/copilot/CopilotLogParser";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";

suite("CopilotLogParser", () => {
  test("extracts session.error metadata while preserving its visible text event", () => {
    const fixture = path.resolve(
      __dirname,
      "../../../src/test/fixtures/harness-errors/copilot/headless-session-error.jsonl"
    );
    const events = fs
      .readFileSync(fixture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const output = new CopilotLogParser().extractResponse(events);
    assert.match(
      output.metadata.error ?? "",
      /Could not connect to local model provider/
    );
    assert.strictEqual(output.metadata.errorType, "query");
    assert.ok(
      output.events.some(
        (event) =>
          event.type === CLI_EVENT_TYPES.TEXT &&
          String((event.data as { text?: string }).text).includes(
            "Could not connect"
          )
      )
    );
  });
});
