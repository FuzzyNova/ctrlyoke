import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { CopilotLogParser } from "../../core/harness/copilot/CopilotLogParser";
import {
  CLI_EVENT_TYPES,
  INLINE_GENERATED_PROMPT_ROOT_TAG,
  INLINE_GENERATED_PROMPT_USER_SECTION_TAG,
} from "../../types/DashboardConstants";

suite("CopilotLogParser", () => {
  test("classifies an echoed inline prompt as the dispatched prompt", () => {
    const root = INLINE_GENERATED_PROMPT_ROOT_TAG;
    const user = INLINE_GENERATED_PROMPT_USER_SECTION_TAG;
    const dispatched = `<${root}>\n<agentInstructions>${"Generated instructions.".repeat(10)}</agentInstructions>\n<${user}>\nReview the project.\n</${user}>\n</${root}>`;
    assert.strictEqual(
      new CopilotLogParser().classifyUserEvent(
        {
          type: "user.message",
          data: {
            content: `<${root}>\n<agentInstructions>Different generated content.</agentInstructions>\n<${user}>\nReview the project.\n</${user}>\n</${root}>`,
          },
        },
        { dispatchedPromptText: dispatched }
      ),
      "injected-prompt"
    );
  });

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
