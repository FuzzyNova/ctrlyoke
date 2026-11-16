import * as assert from "assert";
import { suite, test } from "mocha";
import {
  PROMPT_ECHO_MATCH,
  type PromptEchoMatch,
} from "../../core/harness/shared/BaseLogParser";
import { CodexLogParser } from "../../core/harness/codex/CodexLogParser";
import {
  INLINE_GENERATED_PROMPT_ROOT_TAG,
  INLINE_GENERATED_PROMPT_USER_SECTION_TAG,
} from "../../types/DashboardConstants";

class TestableCodexLogParser extends CodexLogParser {
  matchDispatchedPrompt(
    loggedText: string,
    dispatchedPromptText: string | undefined,
    match: PromptEchoMatch
  ): boolean {
    return this.isDispatchedPromptEcho(loggedText, dispatchedPromptText, match);
  }

  extractUserPrompt(text: string): string {
    return this.extractInlineUserPrompt(text);
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

  test("matches an inline root echo using only the user's prompt section", () => {
    const rootOpen = `<${INLINE_GENERATED_PROMPT_ROOT_TAG}>`;
    const rootClose = `</${INLINE_GENERATED_PROMPT_ROOT_TAG}>`;
    const promptOpen = `<${INLINE_GENERATED_PROMPT_USER_SECTION_TAG}>`;
    const promptClose = `</${INLINE_GENERATED_PROMPT_USER_SECTION_TAG}>`;
    const dispatched = `${rootOpen}\n<agentInstructions>Rules.</agentInstructions>\n${promptOpen}\nDo the work.\n${promptClose}\n${rootClose}`;
    const echoed = `${rootOpen}\n<agentInstructions>Rules.</agentInstructions>\n${promptOpen}\nDo the work.\n${promptClose}\n${rootClose}`;
    assert.strictEqual(parser.extractUserPrompt(dispatched), "Do the work.");

    assert.strictEqual(
      parser.matchDispatchedPrompt(
        echoed,
        dispatched,
        PROMPT_ECHO_MATCH.PREFIX_EQUALS
      ),
      true
    );
    assert.strictEqual(
      parser.matchDispatchedPrompt(
        `${rootOpen}${promptOpen}Different prompt${promptClose}${rootClose}`,
        dispatched,
        PROMPT_ECHO_MATCH.PREFIX_EQUALS
      ),
      false
    );
  });
});
