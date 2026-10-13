import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import type { ScriptRuntimeOutput } from "../../types/CtrlYokeTypes";
import type { CliEvent } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES, StepOutputTextMode } from "../../types/DashboardConstants";
import { sanitizeTerminalOutput } from "../../utils/TerminalOutputSanitizer";
import {
  getAssistantText,
  getScriptOutputText,
  getStepOutputText,
} from "../../utils/StepOutputText";

suite("StepOutputText", () => {
  test("assistant projection includes TEXT events only", () => {
    const events: CliEvent[] = [
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "answer" } },
      { type: CLI_EVENT_TYPES.THINKING, data: { text: "reasoning" } },
      { type: CLI_EVENT_TYPES.TERMINAL_OUTPUT, data: { text: "tail", reason: "exit" } },
    ];
    assert.strictEqual(getAssistantText(events), "answer");
  });

  test("script text matches the historical reporter response projection", () => {
    const scriptOutput: ScriptRuntimeOutput = {
      command: "npm test",
      stdout: "  tests passed\n",
      stderr: "warning\n",
      exitCode: 0,
    };
    const expected = sanitizeTerminalOutput(
      [scriptOutput.stdout, scriptOutput.stderr].filter(Boolean).join("\n").trim()
    );
    assert.strictEqual(getScriptOutputText(scriptOutput), expected);
    assert.strictEqual(
      getStepOutputText({ scriptOutput }, StepOutputTextMode.TRANSCRIPT),
      expected
    );
  });

  test("legacy output remains a fallback when no events or script record exist", () => {
    assert.strictEqual(
      getStepOutputText({ output: { response: "legacy", elapsed: 0, isStreaming: false } }, StepOutputTextMode.ASSISTANT),
      "legacy"
    );
  });

  test("timeline-v1 AI, script, and PTY-tail records retain their legacy text", () => {
    const fixturePath = path.resolve(
      __dirname,
      "../../../src/test/fixtures/formats/timeline/v1/events.jsonl"
    );
    const records = fs
      .readFileSync(fixturePath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { payload: { cliOutput: { response?: string; prompt?: string; elapsed: number; isStreaming: boolean; structured?: { events: CliEvent[]; metadata: object } } } });
    assert.strictEqual(
      getStepOutputText({ output: records[0].payload.cliOutput }, StepOutputTextMode.TRANSCRIPT),
      "AI legacy text"
    );
    assert.strictEqual(
      getStepOutputText({ output: records[1].payload.cliOutput }, StepOutputTextMode.TRANSCRIPT),
      "script legacy text"
    );
    assert.strictEqual(
      getStepOutputText({ output: records[2].payload.cliOutput }, StepOutputTextMode.TRANSCRIPT),
      "process failed\nterminal tail"
    );
  });
});
