import * as assert from "assert";
import { suite, test } from "mocha";
import {
  PROMPT_ECHO_MATCH,
  type PromptEchoMatch,
} from "../../core/harness/shared/BaseLogParser";
import { CodexLogParser } from "../../core/harness/codex/CodexLogParser";

class TestableCodexLogParser extends CodexLogParser {
  matchDispatchedPrompt(
    loggedText: string,
    dispatchedPromptText: string | undefined,
    match: PromptEchoMatch
  ): boolean {
    return this.isDispatchedPromptEcho(loggedText, dispatchedPromptText, match);
  }
}

suite("BaseLogParser dispatched-prompt matching", () => {
  const parser = new TestableCodexLogParser();

  test("supports prefix containment, prefix equality, and full containment", () => {
    const dispatchedPromptText = "Inspect the generated workflow";
    const loggedText = `Copied: ${dispatchedPromptText} [attachment metadata]`;

    assert.strictEqual(
      parser.matchDispatchedPrompt(
        loggedText,
        dispatchedPromptText,
        PROMPT_ECHO_MATCH.PREFIX_CONTAINS
      ),
      true
    );
    assert.strictEqual(
      parser.matchDispatchedPrompt(
        loggedText,
        dispatchedPromptText,
        PROMPT_ECHO_MATCH.PREFIX_EQUALS
      ),
      false
    );
    assert.strictEqual(
      parser.matchDispatchedPrompt(
        loggedText,
        dispatchedPromptText,
        PROMPT_ECHO_MATCH.FULL_CONTAINS
      ),
      true
    );
  });

  test("applies 100-character prefixes and rejects missing dispatched prompts", () => {
    const dispatchedPromptText = "x".repeat(100);

    assert.strictEqual(
      parser.matchDispatchedPrompt(
        `${dispatchedPromptText} trailing text`,
        dispatchedPromptText,
        PROMPT_ECHO_MATCH.PREFIX_EQUALS
      ),
      true
    );
    assert.strictEqual(
      parser.matchDispatchedPrompt(
        `${"x".repeat(100)}needle`,
        "needle",
        PROMPT_ECHO_MATCH.PREFIX_CONTAINS
      ),
      false
    );
    assert.strictEqual(
      parser.matchDispatchedPrompt(
        `${"x".repeat(100)}needle`,
        "needle",
        PROMPT_ECHO_MATCH.FULL_CONTAINS
      ),
      true
    );
    assert.strictEqual(
      parser.matchDispatchedPrompt(
        "anything",
        undefined,
        PROMPT_ECHO_MATCH.FULL_CONTAINS
      ),
      false
    );
  });
});
