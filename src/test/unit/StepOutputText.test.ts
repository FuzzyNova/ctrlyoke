import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { AntigravityLogParser } from "../../core/harness/antigravity/AntigravityLogParser";
import { ClaudeLogParser } from "../../core/harness/claude/ClaudeLogParser";
import { CodexLogParser } from "../../core/harness/codex/CodexLogParser";
import { CopilotLogParser } from "../../core/harness/copilot/CopilotLogParser";
import { OpenCodeLogParser } from "../../core/harness/opencode/OpenCodeLogParser";
import { QwenLogParser } from "../../core/harness/qwen/QwenLogParser";
import { extractTextFromEvents } from "../../core/harness/shared/CliResponseTextExtractor";
import type { BaseCliEvent } from "../../core/harness/shared/interfaces/ILogParser";
import type { ScriptRuntimeOutput } from "../../types/CtrlYokeTypes";
import type { CliEvent } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES, StepOutputTextMode } from "../../types/DashboardConstants";
import { sanitizeTerminalOutput } from "../../utils/TerminalOutputSanitizer";
import { normalizeCliEvents } from "../../utils/CliEventNormalizer";
import {
  getAssistantText,
  getScriptOutputText,
  getStepOutputText,
  getTranscriptText,
} from "../../utils/StepOutputText";

const fixtureRoot = path.resolve(__dirname, "../../../src/test/fixtures");
const harnessFixtures = [
  [new ClaudeLogParser(), "claude/headless-golden.session.jsonl"],
  [new CopilotLogParser(), "copilot/headless-golden.session.jsonl"],
  [new CodexLogParser(), "codex/headless-golden.session.jsonl"],
  [new AntigravityLogParser(), "antigravity/transcript-rich.jsonl"],
  [new OpenCodeLogParser(() => 200_000), "opencode/failed-tool-events.stdout.jsonl"],
  [new QwenLogParser(), "qwen/headless-golden.session.jsonl"],
] as const;

suite("StepOutputText", () => {
  test("transcript projection exactly matches today's extractor for each harness fixture", () => {
    for (const [parser, fixture] of harnessFixtures) {
      const rawEvents = fs
        .readFileSync(path.join(fixtureRoot, fixture), "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as BaseCliEvent);
      const events = parser.extractResponse(rawEvents).events;
      assert.strictEqual(
        getTranscriptText(events),
        extractTextFromEvents({ events: normalizeCliEvents(events) }),
        fixture
      );
    }
  });

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
});
