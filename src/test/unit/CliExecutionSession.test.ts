import * as assert from "assert";
import { suite, test } from "mocha";
import { CliExecutionSession } from "../../flightpath/harness/shared/CliExecutionSession";
import type { CliResult, UniversalCliOutput } from "../../types/CliOutputTypes";

function createParsedOutput(
  overrides?: Partial<UniversalCliOutput>
): UniversalCliOutput {
  return {
    events: [],
    metadata: {},
    ...overrides,
  };
}

function createCliResult(overrides?: Partial<CliResult>): CliResult {
  return {
    success: true,
    response: "ok",
    statistics: "",
    ...overrides,
  };
}

suite("CliExecutionSession", () => {
  test("tracks prepared prompt and command metadata for session-log discovery", () => {
    const session = new CliExecutionSession({
      prompt: { prompt: "original prompt" },
      resolvedSessionId: "session-existing",
    });

    session.preparePrompt("Follow instructions in @prompt.md", ["prompt.md"]);

    assert.strictEqual(
      session.promptArgument,
      "Follow instructions in @prompt.md"
    );
    assert.deepStrictEqual(session.tempFilePaths, ["prompt.md"]);
    assert.strictEqual(
      session.promptForSessionLog,
      "Follow instructions in @prompt.md"
    );

    session.recordCommandPrepared({
      promptArgument: "@prompt.md",
      cliCommand: "test-cli --prompt @prompt.md",
    });

    assert.strictEqual(session.promptForSessionLog, "@prompt.md");
    assert.strictEqual(session.cliCommand, "test-cli --prompt @prompt.md");
    assert.strictEqual(session.effectiveSessionId, "session-existing");
  });

  test("records headless responses and prefers extracted session IDs", () => {
    const parsedOutput = createParsedOutput({
      metadata: { sessionId: "session-output" },
    });
    const cliResult = createCliResult({ response: "headless response" });
    const session = new CliExecutionSession({
      prompt: { prompt: "say hi" },
      resolvedSessionId: "session-existing",
    });

    session.recordHeadlessResponse({
      success: true,
      parsedOutput,
      cliResult,
      extractedSessionId: "session-new",
    });

    assert.strictEqual(session.parsedOutput, parsedOutput);
    assert.strictEqual(session.result, cliResult);
    assert.strictEqual(session.effectiveSessionId, "session-new");
    assert.deepStrictEqual(session.toSnapshot(), {
      cliCommand: undefined,
      parsedOutput,
      result: cliResult,
    });
  });

  test("uses the resolved session ID when no new session is extracted", () => {
    const session = new CliExecutionSession({
      prompt: { prompt: "resume" },
      resolvedSessionId: "session-existing",
    });

    session.updateParsedOutput(createParsedOutput());
    session.updateResult(createCliResult());

    assert.strictEqual(session.effectiveSessionId, "session-existing");
  });
});
