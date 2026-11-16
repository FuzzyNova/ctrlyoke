import * as assert from "assert";
import { suite, test } from "mocha";
import { CodexLogParser } from "../../core/harness/codex/CodexLogParser";
import {
  CODEX_EVENT_TYPES,
  CODEX_PAYLOAD_TYPES,
} from "../../core/harness/codex/CodexProtocolConstants";

suite("CodexLogParser", () => {
  test("inline prompt echoes match the user's prompt section", () => {
    const parser = new CodexLogParser();
    const dispatchedPromptText =
      "<ctrlyokePrompt>\n<agentInstructions>generated rules</agentInstructions>\n<userPrompt>\nPlease inspect the workflow parser\n</userPrompt>\n</ctrlyokePrompt>";
    const event = {
      type: CODEX_EVENT_TYPES.EVENT_MSG,
      line: "user_message",
      payload: {
        type: CODEX_PAYLOAD_TYPES.USER_MESSAGE,
        message: dispatchedPromptText,
      },
    };

    assert.strictEqual(
      parser.classifyUserEvent(event, { dispatchedPromptText }),
      "injected-prompt"
    );
    assert.strictEqual(
      parser.classifyUserEvent(
        {
          ...event,
          payload: {
            ...event.payload,
            message: dispatchedPromptText.replace(
              "Please inspect the workflow parser",
              "Please inspect another workflow"
            ),
          },
        },
        { dispatchedPromptText }
      ),
      "human-steer"
    );
  });
});
