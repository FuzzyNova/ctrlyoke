import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { AntigravityLogParser } from "../../core/harness/antigravity/AntigravityLogParser";
import { AntigravityTranscriptReader } from "../../core/harness/antigravity/AntigravityTranscriptReader";
import { AntigravityToolEventBuilder } from "../../core/harness/antigravity/AntigravityToolEventBuilder";
import { ANTIGRAVITY_TOOL_NAMES } from "../../core/harness/antigravity/AntigravityProtocolConstants";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
  OPERATION_STATUS,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../types/DashboardConstants";
import type { AskUserQuestionData } from "../../types/CliOutputTypes";
import type { BaseCliEvent } from "../../core/harness/shared/interfaces/ILogParser";

async function withTemporaryHome<T>(
  run: (homeDir: string) => Promise<T> | T
): Promise<T> {
  const tempHome = makeTempDir("ctrlyoke-agy-home-");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  try {
    return await run(tempHome);
  } finally {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    removeTempDir(tempHome);
  }
}

interface AntigravityTranscriptSession {
  parser: AntigravityLogParser;
  logPath: string;
  transcriptPath: string;
  appendTranscript: (...entries: unknown[]) => void;
}

async function withAntigravityTranscriptSession<T>(
  initialEntries: unknown[],
  run: (session: AntigravityTranscriptSession) => Promise<T> | T
): Promise<T> {
  return withTemporaryHome(async (homeDir) => {
    const parser = new AntigravityLogParser();
    const sessionId = "99999999-9999-4999-8999-999999999999";
    const logDir = path.join(homeDir, ".gemini", "antigravity-cli", "log");
    const transcriptDir = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId,
      ".system_generated",
      "logs"
    );
    const logPath = path.join(logDir, "cli-20260705_120000.log");
    const transcriptPath = path.join(transcriptDir, "transcript_full.jsonl");

    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      logPath,
      `Starting conversation update stream for ${sessionId}\n`,
      "utf8"
    );
    await parser.readNewLines(logPath);
    fs.mkdirSync(transcriptDir, { recursive: true });

    const appendTranscript = (...entries: unknown[]) => {
      fs.appendFileSync(
        transcriptPath,
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        "utf8"
      );
    };
    appendTranscript(...initialEntries);
    await parser.readNewLines(logPath);

    return run({ parser, logPath, transcriptPath, appendTranscript });
  });
}

function backgroundLaunch(taskId: string): Record<string, unknown> {
  // Real agy output types every tool result "GENERIC" (never a per-tool type
  // like "RUN_COMMAND"), so launch detection keys on status alone.
  return {
    source: "MODEL",
    type: "GENERIC",
    status: "RUNNING",
    content: `Tool is running as a background task with task id: ${taskId}.`,
  };
}

function backgroundCompletion(
  taskId: string,
  result = "completed"
): Record<string, unknown> {
  return {
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    content: `Task id "${taskId}" finished with result: ${result}`,
  };
}

function terminalPlannerResponse(
  content = "The resumed task is complete."
): Record<string, unknown> {
  return {
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content,
  };
}

suite("AntigravityLogParser", () => {
  suite("readNewLines", () => {
    test("parses session and completion markers from plain text logs", async () => {
      const parser = new AntigravityLogParser();
      const tempDir = makeTempDir("ctrlyoke-agy-log-");
      const logPath = path.join(tempDir, "cli-20260705_120000.log");
      const sessionId = "11111111-1111-1111-1111-111111111111";

      try {
        fs.writeFileSync(
          logPath,
          [
            `Starting conversation update stream for ${sessionId}`,
            "regular log line",
            "clearing ResponsePending",
          ].join("\n") + "\n",
          "utf8"
        );

        const events = await parser.readNewLines(logPath);

        assert.strictEqual(events.length, 3);
        assert.strictEqual(events[0].type, "session.created");
        assert.strictEqual(events[1].type, "log.line");
        assert.strictEqual(events[2].type, "response.completed");
        assert.strictEqual(parser.extractSessionId(events), sessionId);
        assert.strictEqual(parser.isComplete(events[2]), true);
      } finally {
        removeTempDir(tempDir);
      }
    });

    test("buffers split session and completion lines until their newline arrives", async () => {
      const parser = new AntigravityLogParser();
      const tempDir = makeTempDir("ctrlyoke-agy-partial-");
      const logPath = path.join(tempDir, "cli-20261014_120000.log");
      const sessionId = "11111111-2222-3333-4444-555555555555";
      try {
        fs.writeFileSync(logPath, "Starting conversation update stream for 11111111-2222-3333-", "utf8");
        assert.deepStrictEqual(await parser.readNewLines(logPath), []);
        fs.appendFileSync(logPath, "4444-555555555555\n", "utf8");
        const sessionEvents = await parser.readNewLines(logPath);
        assert.strictEqual(sessionEvents.filter((event) => event.type === "session.created").length, 1);
        assert.strictEqual(parser.extractSessionId(sessionEvents), sessionId);

        fs.appendFileSync(logPath, "Stream completed, clearing Respon", "utf8");
        assert.deepStrictEqual(await parser.readNewLines(logPath), []);
        fs.appendFileSync(logPath, "sePending\n", "utf8");
        const completionEvents = await parser.readNewLines(logPath);
        assert.strictEqual(completionEvents.filter((event) => event.type === "response.completed").length, 1);
        assert.deepStrictEqual(await parser.readNewLines(logPath), []);
      } finally {
        removeTempDir(tempDir);
      }
    });

    test("decodes a UTF-8 character split across appends", async () => {
      const parser = new AntigravityLogParser();
      const tempDir = makeTempDir("ctrlyoke-agy-utf8-");
      const logPath = path.join(tempDir, "cli-20261014_120000.log");
      const character = "€";
      const bytes = Buffer.from(`value ${character}\n`, "utf8");
      try {
        fs.writeFileSync(logPath, bytes.subarray(0, 8));
        await parser.readNewLines(logPath);
        fs.appendFileSync(logPath, bytes.subarray(8));
        const events = await parser.readNewLines(logPath);
        assert.strictEqual(
          (events[0] as BaseCliEvent & { line?: string }).line,
          `value ${character}`
        );
      } finally {
        removeTempDir(tempDir);
      }
    });

    test("tails follow-ups from the transcript when the discovered Go log stays stale", async () => {
      await withAntigravityTranscriptSession(
        [terminalPlannerResponse("The workflow response.")],
        async ({ parser, logPath, appendTranscript }) => {
          const originalLogSize = fs.statSync(logPath).size;
          const observed: BaseCliEvent[] = [];
          const watcher = parser.watchLogFile(
            logPath,
            (event) => observed.push(event),
            new Date(0)
          );

          try {
            appendTranscript(
              {
                source: "USER_EXPLICIT",
                type: "USER_INPUT",
                status: "DONE",
                content:
                  "<USER_REQUEST>\nDid the first MCP call fail?\n</USER_REQUEST>",
              },
              terminalPlannerResponse("Yes, then the MCP call succeeded.")
            );

            const deadline = Date.now() + 2_000;
            while (
              observed.filter((event) => event.type !== "log.line").length <
                2 &&
              Date.now() < deadline
            ) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }

            assert.strictEqual(
              fs.statSync(logPath).size,
              originalLogSize,
              "the discovered Go log must remain untouched"
            );
            assert.deepStrictEqual(
              observed.map((event) => event.type),
              ["user_input", "transcript.planner"]
            );
            assert.strictEqual(
              parser.extractUserSteerText(observed[0]),
              "Did the first MCP call fail?"
            );
            assert.strictEqual(
              (
                parser.extractStructuredEventsFromEvent(observed[1])[0]
                  .data as {
                  text: string;
                }
              ).text,
              "Yes, then the MCP call succeeded."
            );
          } finally {
            watcher.close();
          }
        }
      );
    });

    test("uses transcript_full as the sole authoritative user-input source", async () => {
      await withTemporaryHome(async (homeDir) => {
        const parser = new AntigravityLogParser();
        const sessionId = "55555555-5555-5555-5555-555555555555";
        const logDir = path.join(homeDir, ".gemini", "antigravity-cli", "log");
        const transcriptDir = path.join(
          homeDir,
          ".gemini",
          "antigravity-cli",
          "brain",
          sessionId,
          ".system_generated",
          "logs"
        );
        const logPath = path.join(logDir, "cli-20260705_120000.log");
        const fullPath = path.join(transcriptDir, "transcript_full.jsonl");
        const compactPath = path.join(transcriptDir, "transcript.jsonl");
        const injected =
          "<USER_REQUEST>\nFollow instructions in c:/workspace/request.prompt.md\n</USER_REQUEST>\n" +
          "<ADDITIONAL_METADATA>ignored wrapper</ADDITIONAL_METADATA>";

        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          logPath,
          `Starting conversation update stream for ${sessionId}\n`,
          "utf8"
        );
        await parser.readNewLines(logPath);

        fs.mkdirSync(transcriptDir, { recursive: true });
        fs.writeFileSync(
          fullPath,
          [
            JSON.stringify({
              source: "USER_EXPLICIT",
              type: "USER_INPUT",
              status: "DONE",
              content: injected,
            }),
            JSON.stringify({
              source: "USER_EXPLICIT",
              type: "USER_INPUT",
              status: "DONE",
              content: "please inspect the generated file",
            }),
          ].join("\n") + "\n",
          "utf8"
        );
        fs.writeFileSync(
          compactPath,
          JSON.stringify({
            source: "USER_EXPLICIT",
            type: "USER_INPUT",
            status: "DONE",
            content: "this compact-only duplicate must not appear",
          }) + "\n",
          "utf8"
        );

        const events = await parser.readNewLines(logPath);
        assert.deepStrictEqual(
          events.map((event) => event.line),
          [
            "Follow instructions in c:/workspace/request.prompt.md",
            "please inspect the generated file",
          ]
        );
        assert.strictEqual(
          parser.classifyUserEvent(events[0], {
            dispatchedPromptText:
              "Follow instructions in c:/workspace/request.prompt.md",
          }),
          "injected-prompt"
        );
        assert.strictEqual(
          parser.classifyUserEvent(events[1], {
            dispatchedPromptText:
              "Follow instructions in c:/workspace/request.prompt.md",
          }),
          "human-steer"
        );
      });
    });

    test("falls back to transcript.jsonl only when transcript_full.jsonl is absent", async () => {
      await withTemporaryHome(async (homeDir) => {
        const parser = new AntigravityLogParser();
        const sessionId = "66666666-6666-6666-6666-666666666666";
        const logDir = path.join(homeDir, ".gemini", "antigravity-cli", "log");
        const transcriptDir = path.join(
          homeDir,
          ".gemini",
          "antigravity-cli",
          "brain",
          sessionId,
          ".system_generated",
          "logs"
        );
        const logPath = path.join(logDir, "cli-20260705_120000.log");
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          logPath,
          `Starting conversation update stream for ${sessionId}\n`,
          "utf8"
        );
        await parser.readNewLines(logPath);
        fs.mkdirSync(transcriptDir, { recursive: true });
        fs.writeFileSync(
          path.join(transcriptDir, "transcript.jsonl"),
          JSON.stringify({
            source: "USER_EXPLICIT",
            type: "USER_INPUT",
            status: "DONE",
            content: "legacy compact prompt",
          }) + "\n",
          "utf8"
        );

        const events = await parser.readNewLines(logPath);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].line, "legacy compact prompt");
      });
    });

    test("emits catch-up transcript entries before Go completion and resumes after partial appends", async () => {
      await withTemporaryHome(async (homeDir) => {
        const parser = new AntigravityLogParser();
        const sessionId = "88888888-8888-8888-8888-888888888888";
        const logDir = path.join(homeDir, ".gemini", "antigravity-cli", "log");
        const transcriptDir = path.join(
          homeDir,
          ".gemini",
          "antigravity-cli",
          "brain",
          sessionId,
          ".system_generated",
          "logs"
        );
        const logPath = path.join(logDir, "cli-20260705_120000.log");
        const transcriptPath = path.join(
          transcriptDir,
          "transcript_full.jsonl"
        );
        const launch = {
          source: "MODEL",
          type: "GENERIC",
          status: "RUNNING",
          content:
            "Tool is running as a background task with task id: session/task-2.",
        };
        const completion = {
          source: "SYSTEM",
          type: "SYSTEM_MESSAGE",
          status: "DONE",
          content: 'Task id "session/task-2" finished with result: completed',
        };
        const initial = {
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Initial assistant output",
        };
        const resumed = {
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Resumed assistant output",
        };

        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          logPath,
          `Starting conversation update stream for ${sessionId}\n`,
          "utf8"
        );
        await parser.readNewLines(logPath);
        fs.mkdirSync(transcriptDir, { recursive: true });
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify(launch) + "\n" + JSON.stringify(initial) + "\n",
          "utf8"
        );
        const initialEvents = await parser.readNewLines(logPath);
        assert.strictEqual(parser.hasPendingBackgroundWork(), true);

        fs.appendFileSync(
          transcriptPath,
          JSON.stringify(completion) + "\n" + JSON.stringify(resumed) + "\n",
          "utf8"
        );
        fs.appendFileSync(logPath, "clearing ResponsePending\n", "utf8");
        const catchUpEvents = await parser.readNewLines(logPath);
        assert.deepStrictEqual(
          catchUpEvents.map((event) => event.type),
          ["transcript.tool", "transcript.planner", "response.completed"]
        );
        assert.strictEqual(parser.hasPendingBackgroundWork(), false);

        const partialLine = JSON.stringify({
          ...resumed,
          content: "Partial resumed output",
        });
        fs.appendFileSync(transcriptPath, partialLine.slice(0, -3), "utf8");
        assert.deepStrictEqual(await parser.readNewLines(logPath), []);
        fs.appendFileSync(transcriptPath, partialLine.slice(-3) + "\n", "utf8");
        const resumedEvents = await parser.readNewLines(logPath);
        assert.deepStrictEqual(
          resumedEvents.map((event) => event.type),
          ["transcript.planner"]
        );

        const response = parser.extractResponse([
          ...initialEvents,
          ...catchUpEvents,
          ...resumedEvents,
        ]);
        assert.deepStrictEqual(
          response.events
            .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
            .map((event) => (event.data as { text: string }).text),
          [
            "Initial assistant output",
            "Resumed assistant output",
            "Partial resumed output",
          ]
        );
      });
    });

    test("tracks overlapping tasks independently and keeps the resume latch through failures", async () => {
      await withAntigravityTranscriptSession(
        [
          backgroundLaunch("session/task-1"),
          backgroundLaunch("session/task-2"),
        ],
        async ({ parser, appendTranscript }) => {
          assert.strictEqual(parser.hasPendingBackgroundWork(), true);

          appendTranscript(backgroundCompletion("session/task-1", "failed"));
          await parser.readNewLines("unused.log");
          assert.strictEqual(parser.hasPendingBackgroundWork(), true);

          appendTranscript(backgroundCompletion("session/task-2", "failed"));
          await parser.readNewLines("unused.log");
          assert.strictEqual(parser.hasPendingBackgroundWork(), true);

          appendTranscript(terminalPlannerResponse());
          await parser.readNewLines("unused.log");
          assert.strictEqual(parser.hasPendingBackgroundWork(), false);
        }
      );
    });

    test("ignores unmatched system notifications and only consumes the matching task", async () => {
      await withAntigravityTranscriptSession(
        [
          backgroundLaunch("session/task-1"),
          backgroundLaunch("session/task-2"),
        ],
        async ({ parser, appendTranscript }) => {
          appendTranscript(backgroundCompletion("session/unknown"));
          await parser.readNewLines("unused.log");
          assert.strictEqual(parser.hasPendingBackgroundWork(), true);

          appendTranscript(backgroundCompletion("session/task-1"));
          await parser.readNewLines("unused.log");
          assert.strictEqual(parser.hasPendingBackgroundWork(), true);
        }
      );
    });

    test("unblocks immediately once a catch-up read consumes both the notification and the resumed terminal response", async () => {
      // Antigravity runs no stale-stop guard: its transcript watcher polls
      // independently of Stop-hook timing, so once a single catch-up read
      // has consumed the notification and the terminal planner response,
      // completion is no longer blocked — there is no extra check to wait
      // out for a follow-up Stop hook that a finished agy turn never emits.
      await withAntigravityTranscriptSession(
        [backgroundLaunch("session/task-1")],
        async ({ parser, appendTranscript }) => {
          appendTranscript(
            backgroundCompletion("session/task-1"),
            terminalPlannerResponse()
          );
          const events = await parser.readNewLines("unused.log");
          assert.deepStrictEqual(
            events.map((event) => event.type),
            ["transcript.tool", "transcript.planner"]
          );
          assert.strictEqual(parser.hasPendingBackgroundWork(), false);
        }
      );
    });

    test("keeps a new launch pending while the resumed turn is still active", async () => {
      await withAntigravityTranscriptSession(
        [backgroundLaunch("session/task-1")],
        async ({ parser, appendTranscript }) => {
          appendTranscript(
            backgroundCompletion("session/task-1"),
            {
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "I will start another background task.",
              tool_calls: [{ name: "run_command", args: {} }],
            },
            backgroundLaunch("session/task-2")
          );
          await parser.readNewLines("unused.log");
          assert.strictEqual(parser.hasPendingBackgroundWork(), true);

          appendTranscript(backgroundCompletion("session/task-2"));
          await parser.readNewLines("unused.log");
          assert.strictEqual(parser.hasPendingBackgroundWork(), true);

          appendTranscript(terminalPlannerResponse());
          await parser.readNewLines("unused.log");
          assert.strictEqual(parser.hasPendingBackgroundWork(), false);
        }
      );
    });

    test("clears provider background state when a new session is discovered", async () => {
      await withTemporaryHome(async (homeDir) => {
        const parser = new AntigravityLogParser();
        const firstSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const secondSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const logDir = path.join(homeDir, ".gemini", "antigravity-cli", "log");
        const firstTranscriptDir = path.join(
          homeDir,
          ".gemini",
          "antigravity-cli",
          "brain",
          firstSessionId,
          ".system_generated",
          "logs"
        );
        const secondTranscriptDir = path.join(
          homeDir,
          ".gemini",
          "antigravity-cli",
          "brain",
          secondSessionId,
          ".system_generated",
          "logs"
        );
        const logPath = path.join(logDir, "cli-20260705_120000.log");
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          logPath,
          `Starting conversation update stream for ${firstSessionId}\n`,
          "utf8"
        );
        await parser.readNewLines(logPath);
        fs.mkdirSync(firstTranscriptDir, { recursive: true });
        fs.writeFileSync(
          path.join(firstTranscriptDir, "transcript_full.jsonl"),
          JSON.stringify(backgroundLaunch("session/task-1")) + "\n",
          "utf8"
        );
        await parser.readNewLines(logPath);
        assert.strictEqual(parser.hasPendingBackgroundWork(), true);

        fs.mkdirSync(secondTranscriptDir, { recursive: true });
        fs.appendFileSync(
          logPath,
          `Starting conversation update stream for ${secondSessionId}\n`,
          "utf8"
        );
        await parser.readNewLines(logPath);
        assert.strictEqual(parser.hasPendingBackgroundWork(), false);
      });
    });
  });

  suite("AntigravityTranscriptReader", () => {
    function entry(content: string, step_index: number) {
      return {
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        step_index,
        content,
      };
    }

    test("emits appended entries once and preserves file order", async () => {
      const tempDir = makeTempDir("ctrlyoke-agy-tail-");
      const transcriptPath = path.join(tempDir, "transcript_full.jsonl");
      const reader = new AntigravityTranscriptReader();
      try {
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify(entry("first", 3)) + "\n",
          "utf8"
        );
        assert.deepStrictEqual(
          (await reader.readRecords(transcriptPath)).map(
            (record) => record.entry.content
          ),
          ["first"]
        );
        fs.appendFileSync(
          transcriptPath,
          JSON.stringify(entry("second", 2)) + "\n",
          "utf8"
        );
        assert.deepStrictEqual(
          (await reader.readRecords(transcriptPath)).map(
            (record) => record.entry.content
          ),
          ["second"]
        );
        assert.deepStrictEqual(await reader.readRecords(transcriptPath), []);
      } finally {
        removeTempDir(tempDir);
      }
    });

    test("emits each entry once when reads overlap", async () => {
      const tempDir = makeTempDir("ctrlyoke-agy-race-");
      const transcriptPath = path.join(tempDir, "transcript_full.jsonl");
      const reader = new AntigravityTranscriptReader();
      try {
        fs.writeFileSync(
          transcriptPath,
          [entry("first", 1), entry("second", 2)]
            .map((item) => JSON.stringify(item))
            .join("\n") + "\n",
          "utf8"
        );

        // CliLogMonitor drives readNewLines from the fs.watch callback, the
        // initial/catch-up reads and the drain loop without awaiting between
        // them; overlapping reads must not replay the same byte range.
        const batches = await Promise.all([
          reader.readRecords(transcriptPath),
          reader.readRecords(transcriptPath),
          reader.readRecords(transcriptPath),
        ]);

        const contents = batches.flatMap((batch) =>
          batch.map((record) => record.entry.content)
        );
        assert.deepStrictEqual(contents, ["first", "second"]);

        const lineNumbers = batches.flatMap((batch) =>
          batch.map((record) => record.lineNumber)
        );
        assert.deepStrictEqual(lineNumbers, [0, 1]);

        fs.appendFileSync(
          transcriptPath,
          JSON.stringify(entry("third", 3)) + "\n",
          "utf8"
        );
        const appended = await Promise.all([
          reader.readRecords(transcriptPath),
          reader.readRecords(transcriptPath),
        ]);
        assert.deepStrictEqual(
          appended.flat().map((record) => record.entry.content),
          ["third"]
        );
      } finally {
        removeTempDir(tempDir);
      }
    });

    test("preserves incremental read offset when the retained prefix splits a multi-byte character", async () => {
      const tempDir = makeTempDir("ctrlyoke-agy-utf8-");
      const transcriptPath = path.join(tempDir, "transcript_full.jsonl");
      const reader = new AntigravityTranscriptReader();
      try {
        // Long enough that the 128-byte prefix window lands mid-character:
        // '•' and '↩' are 3 bytes each, '🚀' is 4.
        const utf8Content = "• UTF-8 ↩ 🚀 ".repeat(12);
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify(entry(utf8Content, 1)) + "\n",
          "utf8"
        );
        const firstBatch = await reader.readRecords(transcriptPath);
        assert.strictEqual(firstBatch.length, 1);
        assert.strictEqual(firstBatch[0].entry.content, utf8Content);

        // Appending must not look like a rewrite to the prefix check.
        fs.appendFileSync(
          transcriptPath,
          JSON.stringify(entry("second entry", 2)) + "\n",
          "utf8"
        );
        const secondBatch = await reader.readRecords(transcriptPath);
        assert.strictEqual(secondBatch.length, 1);
        assert.strictEqual(secondBatch[0].entry.content, "second entry");

        assert.deepStrictEqual(await reader.readRecords(transcriptPath), []);
      } finally {
        removeTempDir(tempDir);
      }
    });

    test("holds a partial trailing line until the next append", async () => {
      const tempDir = makeTempDir("ctrlyoke-agy-tail-");
      const transcriptPath = path.join(tempDir, "transcript_full.jsonl");
      const reader = new AntigravityTranscriptReader();
      const serialized = JSON.stringify(entry("partial", 1));
      try {
        fs.writeFileSync(transcriptPath, serialized.slice(0, -4), "utf8");
        assert.deepStrictEqual(await reader.readRecords(transcriptPath), []);
        fs.appendFileSync(transcriptPath, serialized.slice(-4) + "\n", "utf8");
        const entries = await reader.readRecords(transcriptPath);
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].entry.content, "partial");
      } finally {
        removeTempDir(tempDir);
      }
    });

    test("restarts from the beginning when a transcript is replaced or truncated", async () => {
      const tempDir = makeTempDir("ctrlyoke-agy-tail-");
      const transcriptPath = path.join(tempDir, "transcript_full.jsonl");
      const reader = new AntigravityTranscriptReader();
      try {
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify(entry("original", 1)) + "\n",
          "utf8"
        );
        assert.strictEqual(
          (await reader.readRecords(transcriptPath)).length,
          1
        );
        fs.writeFileSync(
          transcriptPath,
          JSON.stringify(entry("replacement", 1)) + "\n",
          "utf8"
        );
        const replacement = await reader.readRecords(transcriptPath);
        assert.strictEqual(replacement.length, 1);
        assert.strictEqual(replacement[0].entry.content, "replacement");
      } finally {
        removeTempDir(tempDir);
      }
    });

    test("skips malformed and unknown transcript variants safely", async () => {
      const tempDir = makeTempDir("ctrlyoke-agy-tail-");
      const transcriptPath = path.join(tempDir, "transcript_full.jsonl");
      const reader = new AntigravityTranscriptReader();
      try {
        fs.writeFileSync(
          transcriptPath,
          [
            "not json",
            JSON.stringify({ source: "MODEL", type: "UNKNOWN" }),
            JSON.stringify(entry("valid", 4)),
          ].join("\n") + "\n",
          "utf8"
        );
        const entries = await reader.readRecords(transcriptPath);
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].entry.content, "valid");
      } finally {
        removeTempDir(tempDir);
      }
    });
  });

  suite("transcript mapping", () => {
    test("does not infer non-command success from exit-code text in content", () => {
      const fileRead = AntigravityToolEventBuilder.build({
        call: { name: "view_file", args: { AbsolutePath: "log.txt" } },
        result: {
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          content: 'log output: exit code: 1',
        },
        timestamp: 1,
      });
      assert.strictEqual(fileRead[0].type, CLI_EVENT_TYPES.FILE_READ);
      assert.strictEqual(
        (fileRead[0].data as { status: string }).status,
        OPERATION_STATUS.COMPLETED
      );

      const command = AntigravityToolEventBuilder.build({
        call: { name: "run_command", args: { CommandLine: "false" } },
        result: {
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          content: "Output:\nExit code: 1\n",
        },
        timestamp: 2,
      });
      assert.strictEqual(command[0].type, CLI_EVENT_TYPES.BASH_COMMAND);
      assert.strictEqual(
        (command[0].data as { status: string }).status,
        OPERATION_STATUS.FAILED
      );
    });

    test("maps text, thinking, user messages, and checkpoints in arrival order", async () => {
      await withTemporaryHome(async (homeDir) => {
        const parser = new AntigravityLogParser();
        const sessionId = "77777777-7777-7777-7777-777777777777";
        const logDir = path.join(homeDir, ".gemini", "antigravity-cli", "log");
        const transcriptDir = path.join(
          homeDir,
          ".gemini",
          "antigravity-cli",
          "brain",
          sessionId,
          ".system_generated",
          "logs"
        );
        const logPath = path.join(logDir, "cli-20260705_120000.log");
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          logPath,
          `Starting conversation update stream for ${sessionId}\n`,
          "utf8"
        );
        await parser.readNewLines(logPath);
        fs.mkdirSync(transcriptDir, { recursive: true });
        const transcriptPath = path.join(
          transcriptDir,
          "transcript_full.jsonl"
        );
        fs.writeFileSync(
          transcriptPath,
          [
            {
              source: "USER_EXPLICIT",
              type: "USER_INPUT",
              status: "DONE",
              content:
                "<USER_REQUEST>\nFollow instructions in request.prompt.md\n</USER_REQUEST>",
            },
            {
              source: "USER_EXPLICIT",
              type: "USER_INPUT",
              status: "DONE",
              content: "please also inspect the output",
            },
            {
              step_index: 8,
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "I will inspect the output.",
              thinking: "First I need to inspect the output carefully.",
              tool_calls: [
                {
                  name: "view_file",
                  args: { AbsolutePath: "C:/workspace/output.txt" },
                },
              ],
            },
            {
              // Baseline scaffold every conversation gets — never a compaction.
              step_index: 2,
              source: "SYSTEM",
              type: "CHECKPOINT",
              status: "DONE",
              content: "{{ CHECKPOINT 0 }}",
            },
            {
              step_index: 10,
              source: "SYSTEM",
              type: "CHECKPOINT",
              status: "DONE",
              content: "{{ CHECKPOINT 1 }}",
            },
            {
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "RUNNING",
              content: "must be ignored",
            },
            {
              source: "MODEL",
              type: "UNRECOGNIZED_VARIANT",
              status: "DONE",
              content: "must also be ignored",
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
          "utf8"
        );

        const events = await parser.readNewLines(logPath);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          [
            "user_input",
            "user_input",
            "transcript.planner",
            "transcript.checkpoint",
          ]
        );
        assert.strictEqual(
          parser.classifyUserEvent(events[0], {
            dispatchedPromptText: "Follow instructions in request.prompt.md",
          }),
          "injected-prompt"
        );
        assert.strictEqual(
          parser.classifyUserEvent(events[1], {
            dispatchedPromptText: "Follow instructions in request.prompt.md",
          }),
          "human-steer"
        );

        const planner = events[2] as BaseCliEvent & {
          eventId: string;
          plannerToolCalls: Array<{ name: string }>;
        };
        assert.ok(planner.eventId.includes("transcript_full.jsonl"));
        assert.strictEqual(planner.plannerToolCalls[0].name, "view_file");

        const mappedPlanner = parser.extractStructuredEventsFromEvent(
          events[2]
        );
        assert.deepStrictEqual(
          mappedPlanner.map((event) => event.type),
          [CLI_EVENT_TYPES.TEXT, CLI_EVENT_TYPES.THINKING]
        );
        assert.strictEqual(
          (mappedPlanner[0].data as { text: string }).text,
          "I will inspect the output."
        );
        assert.strictEqual(
          (mappedPlanner[1].data as { text: string }).text,
          "First I need to inspect the output carefully."
        );
        const checkpoint = parser.extractStructuredEventsFromEvent(events[3]);
        assert.strictEqual(checkpoint[0].type, CLI_EVENT_TYPES.COMPACTION);
        assert.strictEqual(
          (checkpoint[0].data as { summary?: string }).summary,
          "{{ CHECKPOINT 1 }}"
        );

        assert.deepStrictEqual(await parser.readNewLines(logPath), []);
        fs.appendFileSync(
          transcriptPath,
          JSON.stringify({
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            status: "DONE",
            content: "A later response",
          }) + "\n",
          "utf8"
        );
        const appended = await parser.readNewLines(logPath);
        assert.strictEqual(appended.length, 1);
        assert.notStrictEqual(
          (appended[0] as BaseCliEvent & { eventId: string }).eventId,
          planner.eventId
        );
      });
    });

    test("maps ask_question calls and answers into a semantic question event", async () => {
      await withAntigravityTranscriptSession(
        [],
        async ({ parser, logPath, appendTranscript }) => {
          appendTranscript(
            {
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              created_at: "2026-08-13T21:54:12Z",
              tool_calls: [
                {
                  name: "ask_question",
                  args: {
                    questions: [
                      {
                        is_multi_select: false,
                        question: "What's your favorite animal?",
                        options: [
                          "(Recommended) dog - Loyal and playful companion.\nASCII Art:\n / \\__",
                          "cat - Curious and independent.\nASCII Art:\n /\\_/\\\n( o.o )",
                          "snake - Sleek and quiet reptile.\nASCII Art:\n  ~~\\",
                        ],
                      },
                    ],
                  },
                },
              ],
            },
            {
              source: "MODEL",
              type: "ASK_QUESTION",
              status: "DONE",
              created_at: "2026-08-13T21:54:43Z",
              content:
                "Created At: 2026-08-13T21:54:14-05:00\n" +
                "Completed At: 2026-08-13T21:54:43-05:00\n" +
                "A1: snake - Sleek and quiet reptile.\n" +
                "ASCII Art:\n" +
                "  ~~\\",
            }
          );
          const events = await parser.readNewLines(logPath);
          const structured = events.flatMap((event) =>
            parser.extractStructuredEventsFromEvent(event)
          );

          assert.deepStrictEqual(
            structured.map((event) => event.type),
            [
              CLI_EVENT_TYPES.ASK_USER_QUESTION,
              CLI_EVENT_TYPES.ASK_USER_QUESTION,
            ]
          );

          const initiated = structured[0].data as AskUserQuestionData;
          assert.strictEqual(initiated.status, OPERATION_STATUS.INITIATED);
          assert.strictEqual(
            initiated.questions[0].question,
            "What's your favorite animal?"
          );
          assert.deepStrictEqual(
            initiated.questions[0].options.map((option) => option.label),
            ["dog", "cat", "snake"]
          );
          assert.strictEqual(
            initiated.questions[0].options[1].description,
            "Curious and independent."
          );
          assert.strictEqual(
            initiated.questions[0].options[1].preview,
            " /\\_/\\\n( o.o )"
          );

          const completed = structured[1].data as AskUserQuestionData;
          assert.strictEqual(completed.status, OPERATION_STATUS.COMPLETED);
          assert.strictEqual(completed.questions[0].answer, "snake");
          assert.strictEqual(completed.questions[0].answerPreview, "  ~~\\");

          const output = parser.extractResponse(events);
          assert.strictEqual(
            output.events.filter(
              (event) => event.type === CLI_EVENT_TYPES.ASK_USER_QUESTION
            ).length,
            2
          );
          assert.strictEqual(
            output.events.filter(
              (event) => event.type === CLI_EVENT_TYPES.TOOL_CALL
            ).length,
            0
          );
        }
      );
    });

    test("maps view_file line-range reads and confirms them from the rendered summary", async () => {
      await withAntigravityTranscriptSession(
        [],
        async ({ parser, logPath, appendTranscript }) => {
          appendTranscript(
            {
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              created_at: "2026-09-01T14:44:09Z",
              tool_calls: [
                {
                  name: "view_file",
                  args: {
                    AbsolutePath: "C:/workspace/src/index.ts",
                    StartLine: 384,
                    EndLine: 428,
                  },
                },
              ],
            },
            {
              source: "MODEL",
              type: "GENERIC",
              status: "DONE",
              created_at: "2026-09-01T14:44:11Z",
              content:
                "File Path: `file:///C:/workspace/src/index.ts`\n" +
                "Total Lines: 488\n" +
                "Total Bytes: 15343\n" +
                "Showing lines 384 to 428\n" +
                "384: export const FileReadOutput = () => {",
            }
          );

          const events = await parser.readNewLines(logPath);
          const output = parser.extractResponse(events);
          const read = output.events.find(
            (event) => event.type === CLI_EVENT_TYPES.FILE_READ
          );
          assert.ok(read);
          assert.strictEqual(
            (read?.data as { lineStart?: number }).lineStart,
            384
          );
          assert.strictEqual((read?.data as { lineEnd?: number }).lineEnd, 428);
        }
      );
    });

    test("does not surface a line range for a whole-file view_file read", async () => {
      await withAntigravityTranscriptSession(
        [],
        async ({ parser, logPath, appendTranscript }) => {
          appendTranscript(
            {
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              created_at: "2026-09-01T14:44:08Z",
              tool_calls: [
                {
                  name: "view_file",
                  args: { AbsolutePath: "C:/workspace/small.txt" },
                },
              ],
            },
            {
              source: "MODEL",
              type: "GENERIC",
              status: "DONE",
              created_at: "2026-09-01T14:44:09Z",
              content:
                "File Path: `file:///C:/workspace/small.txt`\n" +
                "Total Lines: 1\n" +
                "Total Bytes: 306\n" +
                "Showing lines 1 to 1\n" +
                "1: hello world",
            }
          );

          const events = await parser.readNewLines(logPath);
          const output = parser.extractResponse(events);
          const read = output.events.find(
            (event) => event.type === CLI_EVENT_TYPES.FILE_READ
          );
          assert.ok(read);
          assert.strictEqual(
            (read?.data as { lineStart?: number }).lineStart,
            undefined
          );
          assert.strictEqual(
            (read?.data as { lineEnd?: number }).lineEnd,
            undefined
          );
        }
      );
    });
  });

  suite("extractResponse", () => {
    test("returns transcript text output and session metadata", () => {
      const parser = new AntigravityLogParser();

      const result = parser.extractResponse([
        {
          type: "log.line",
          line: "first line",
          sessionId: "22222222-2222-2222-2222-222222222222",
        },
        {
          type: "response.text",
          line: "second line",
          sessionId: "22222222-2222-2222-2222-222222222222",
        },
      ]);

      assert.strictEqual(result.metadata.harness, HARNESS_IDS.ANTIGRAVITY_CLI);
      assert.strictEqual(
        result.metadata.sessionId,
        "22222222-2222-2222-2222-222222222222"
      );
      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].type, CLI_EVENT_TYPES.TEXT);
      assert.strictEqual(
        (result.events[0].data as { text: string }).text,
        "second line"
      );
    });

    test("includes exact context window usage from parsed events when available", () => {
      const parser = new AntigravityLogParser();

      const result = parser.extractResponse([
        {
          type: "response.text",
          line: "answer",
          sessionId: "22222222-2222-2222-2222-222222222222",
          contextWindowUsedTokens: 42,
          contextWindowSize: 1_000_000,
          outputTokens: 3,
          currentUsage: {
            inputTokens: 17,
            outputTokens: 2,
            cacheCreationInputTokens: 5,
            cacheReadInputTokens: 11,
          },
        },
      ]);

      assert.strictEqual(result.metadata.usage?.contextWindowUsedTokens, 42);
      assert.strictEqual(result.metadata.usage?.contextWindowSize, 1_000_000);
      assert.strictEqual(result.metadata.usage?.inputTokens, 17);
      assert.strictEqual(result.metadata.usage?.outputTokens, 2);
      assert.strictEqual(result.metadata.usage?.totalTokens, 19);
      assert.strictEqual(result.metadata.usage?.cacheCreatedTokens, 5);
      assert.strictEqual(result.metadata.usage?.cachedInputTokens, 11);
    });

    test("uses the latest statusline snapshot when interactive events have no usage", () => {
      const parser = new AntigravityLogParser();

      parser.setStatuslineSnapshot({
        model: { id: "gemini-test" },
        context_window: {
          total_input_tokens: 1_000,
          total_output_tokens: 200,
          context_window_size: 10_000,
          current_usage: {
            input_tokens: 120,
            output_tokens: 7,
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 30,
          },
        },
      });

      const result = parser.extractResponse([
        { type: "response.text", line: "answer" },
      ]);

      assert.strictEqual(result.metadata.usage?.inputTokens, 120);
      assert.strictEqual(result.metadata.usage?.outputTokens, 7);
      assert.strictEqual(result.metadata.usage?.totalTokens, 127);
      assert.strictEqual(result.metadata.usage?.cachedInputTokens, 30);
      assert.strictEqual(result.metadata.usage?.cacheCreatedTokens, 40);
      assert.strictEqual(result.metadata.usage?.contextWindowUsedTokens, 1_200);
      assert.strictEqual(result.metadata.usage?.contextWindowSize, 10_000);
      assert.strictEqual(
        result.metadata.usage?.totalConfidence,
        TOKEN_TOTAL_CONFIDENCE.PARTIAL
      );
    });

    test("uses stream-json billing fields and statusline context fields", () => {
      const parser = new AntigravityLogParser();
      parser.setStatuslineSnapshot({
        model: { id: "gemini-test" },
        context_window: {
          total_input_tokens: 1_000,
          total_output_tokens: 200,
          context_window_size: 10_000,
          current_usage: {
            input_tokens: 120,
            output_tokens: 7,
          },
        },
      });
      parser.setStreamJsonUsage({
        latestStepUsage: {
          inputTokens: 800,
          outputTokens: 12,
          reasoningOutputTokens: 13,
          totalTokens: 812,
        },
        terminalUsage: {
          inputTokens: 900,
          outputTokens: 14,
          reasoningOutputTokens: 15,
          cachedInputTokens: 22,
          totalTokens: 914,
        },
      });

      const result = parser.extractResponse([
        { type: "response.text", line: "answer" },
      ]);

      assert.strictEqual(result.metadata.usage?.inputTokens, 900);
      assert.strictEqual(result.metadata.usage?.outputTokens, 14);
      assert.strictEqual(result.metadata.usage?.totalTokens, 914);
      assert.strictEqual(result.metadata.usage?.cachedInputTokens, 22);
      assert.strictEqual(result.metadata.usage?.contextWindowUsedTokens, 1_200);
      assert.strictEqual(result.metadata.usage?.contextWindowSize, 10_000);
      assert.strictEqual(result.metadata.usage?.reasoningOutputTokens, 15);
      assert.strictEqual(
        result.metadata.usage?.totalConfidence,
        TOKEN_TOTAL_CONFIDENCE.PROVIDER
      );
    });

    test("uses stream-json as the per-turn fallback without a statusline", () => {
      const parser = new AntigravityLogParser();
      parser.setStreamJsonUsage({
        latestStepUsage: {
          inputTokens: 99,
          outputTokens: 3,
          reasoningOutputTokens: 2,
          cachedInputTokens: 11,
          totalTokens: 102,
        },
      });

      const result = parser.extractResponse([
        { type: "response.text", line: "answer" },
      ]);

      assert.strictEqual(result.metadata.usage?.inputTokens, 99);
      assert.strictEqual(result.metadata.usage?.outputTokens, 3);
      assert.strictEqual(result.metadata.usage?.totalTokens, 102);
      assert.strictEqual(result.metadata.usage?.cachedInputTokens, 11);
      assert.strictEqual(result.metadata.usage?.reasoningOutputTokens, 2);
    });

    test("does not expose infrastructure log lines as response text", () => {
      const parser = new AntigravityLogParser();

      const result = parser.extractResponse([
        {
          type: "log.line",
          line: "I0706 11:27:16.479259 server.go:834] Starting conversation update stream",
          sessionId: "22222222-2222-2222-2222-222222222222",
        },
      ]);

      assert.strictEqual(result.events.length, 0);
      assert.strictEqual(
        result.metadata.sessionId,
        "22222222-2222-2222-2222-222222222222"
      );
    });
  });

  suite("rich transcript tool mapping", () => {
    test("pairs ERROR tool results with their calls and preserves failure output", async () => {
      await withTemporaryHome(async (homeDir) => {
        const parser = new AntigravityLogParser();
        const sessionId = "55555555-5555-4555-8555-555555555555";
        const logDir = path.join(homeDir, ".gemini", "antigravity-cli", "log");
        const logPath = path.join(logDir, "cli-20261002_120000.log");
        const transcriptDir = path.join(
          homeDir,
          ".gemini",
          "antigravity-cli",
          "brain",
          sessionId,
          ".system_generated",
          "logs"
        );
        const transcriptPath = path.join(
          transcriptDir,
          "transcript_full.jsonl"
        );
        const fixturePath = path.resolve(
          __dirname,
          "../../../src/test/fixtures/antigravity/transcript-error-tool-result.jsonl"
        );

        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          logPath,
          `Starting conversation update stream for ${sessionId}\n`,
          "utf8"
        );
        await parser.readNewLines(logPath);
        fs.mkdirSync(transcriptDir, { recursive: true });
        fs.copyFileSync(fixturePath, transcriptPath);

        const rawEvents = await parser.readNewLines(logPath);
        const output = parser.extractResponse(rawEvents);
        const toolCalls = output.events
          .filter((event) => event.type === CLI_EVENT_TYPES.TOOL_CALL)
          .map((event) => {
            const data = event.data as {
              name: string;
              parameters: Record<string, unknown>;
              result?: { success?: boolean; output?: string };
            };
            return {
              ...data,
              result: data.result
                ? {
                    success: data.result.success,
                    output: data.result.output,
                  }
                : undefined,
            };
          });

        assert.deepStrictEqual(
          toolCalls.map(({ name, result }) => ({ name, result })),
          [
            {
              name: "first_custom_tool",
              result: {
                success: false,
                output: "post_note.text is required",
              },
            },
            {
              name: "second_custom_tool",
              result: { success: true, output: "README contents" },
            },
          ]
        );
        assert.deepStrictEqual(
          toolCalls.map(({ parameters }) => parameters),
          [{ request: "first" }, { request: "second" }]
        );
      });
    });

    test("maps adjacent calls/results in file order and preserves identities", async () => {
      await withTemporaryHome(async (homeDir) => {
        const parser = new AntigravityLogParser();
        const sessionId = "44444444-4444-4444-4444-444444444444";
        const logDir = path.join(homeDir, ".gemini", "antigravity-cli", "log");
        const logPath = path.join(logDir, "cli-20260705_120000.log");
        const transcriptDir = path.join(
          homeDir,
          ".gemini",
          "antigravity-cli",
          "brain",
          sessionId,
          ".system_generated",
          "logs"
        );
        const transcriptPath = path.join(
          transcriptDir,
          "transcript_full.jsonl"
        );
        const fixturePath = path.resolve(
          __dirname,
          "../../../src/test/fixtures/antigravity/transcript-rich.jsonl"
        );

        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          logPath,
          `Starting conversation update stream for ${sessionId}\n`,
          "utf8"
        );
        await parser.readNewLines(logPath);
        fs.mkdirSync(transcriptDir, { recursive: true });
        fs.copyFileSync(fixturePath, transcriptPath);

        const rawEvents = await parser.readNewLines(logPath);
        const output = parser.extractResponse(rawEvents);
        const types = output.events.map((event) => event.type);

        assert.ok(types.includes(CLI_EVENT_TYPES.THINKING));
        assert.ok(types.includes(CLI_EVENT_TYPES.BASH_COMMAND));
        assert.ok(types.includes(CLI_EVENT_TYPES.FILE_READ));
        assert.ok(types.includes(CLI_EVENT_TYPES.FILE_WRITE));
        assert.ok(types.includes(CLI_EVENT_TYPES.FILE_EDIT));
        assert.ok(types.includes(CLI_EVENT_TYPES.MCP_TOOL_CALL));
        assert.ok(types.includes(CLI_EVENT_TYPES.WEB_SEARCH));
        assert.ok(types.includes(CLI_EVENT_TYPES.COMPACTION));
        assert.ok(
          types.filter((type) => type === CLI_EVENT_TYPES.TOOL_CALL).length >= 3
        );

        const command = output.events.find(
          (event) => event.type === CLI_EVENT_TYPES.BASH_COMMAND
        );
        assert.strictEqual(
          (command?.data as { command: string }).command,
          "npm test -- --runInBand"
        );
        assert.strictEqual(
          (command?.data as { exitCode?: number }).exitCode,
          1
        );
        assert.strictEqual(
          (command?.data as { status?: string }).status,
          "failed"
        );

        const read = output.events.find(
          (event) => event.type === CLI_EVENT_TYPES.FILE_READ
        );
        assert.strictEqual(
          (read?.data as { path: string }).path,
          "C:/workspace/src/index.ts"
        );
        assert.ok(
          (read?.data as { content?: string }).content?.includes("first line")
        );

        const write = output.events.find(
          (event) => event.type === CLI_EVENT_TYPES.FILE_WRITE
        );
        assert.strictEqual(
          (write?.data as { content: string }).content,
          "created content\n"
        );

        const edit = output.events.find(
          (event) => event.type === CLI_EVENT_TYPES.FILE_EDIT
        );
        assert.strictEqual(
          (edit?.data as { structuredPatch?: unknown[] }).structuredPatch
            ?.length,
          1
        );

        const mcp = output.events.find(
          (event) => event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL
        );
        assert.deepStrictEqual(
          {
            server: (mcp?.data as { server: string }).server,
            tool: (mcp?.data as { tool: string }).tool,
          },
          { server: "ctrlyoke", tool: "queue_status" }
        );
        const search = output.events.find(
          (event) => event.type === CLI_EVENT_TYPES.WEB_SEARCH
        );
        assert.strictEqual(
          (search?.data as { query: string }).query,
          "Antigravity transcript parser"
        );
        assert.strictEqual(
          (search?.data as { summary?: string }).summary,
          "Summary text"
        );

        const launch = output.events.find(
          (event) =>
            event.type === CLI_EVENT_TYPES.TOOL_CALL &&
            (event.data as { name?: string }).name ===
              ANTIGRAVITY_TOOL_NAMES.RUN_COMMAND
        );
        assert.strictEqual(
          (launch?.data as { id?: string }).id,
          "session/task-1"
        );
        const completion = output.events.find(
          (event) =>
            event.type === CLI_EVENT_TYPES.TOOL_CALL &&
            (event.data as { name?: string }).name === "background_task"
        );
        assert.strictEqual(
          (completion?.data as { id?: string }).id,
          "session/task-1"
        );
        assert.strictEqual(
          (completion?.data as { result?: { output?: string } }).result?.output,
          'Task id "session/task-1" finished with result: failed (exit code 1)'
        );
        assert.strictEqual(
          (completion?.data as { result?: { success?: boolean } }).result
            ?.success,
          false
        );
        const unmatched = output.events.find(
          (event) =>
            event.type === CLI_EVENT_TYPES.TOOL_CALL &&
            (event.data as { name?: string }).name === "unknown_tool"
        );
        assert.deepStrictEqual(
          (unmatched?.data as { parameters?: Record<string, unknown> })
            .parameters,
          { value: 42 }
        );

        assert.deepStrictEqual(await parser.readNewLines(logPath), []);
      });
    });
  });

  suite("extractLiveContextWindow", () => {
    test("returns exact context usage from parsed events", () => {
      const parser = new AntigravityLogParser();

      const result = parser.extractLiveContextWindow(
        {
          type: "log.line",
          line: "future usage line",
          contextWindowUsedTokens: 17_000,
          contextWindowSize: 1_000_000,
        },
        "gemini-3.5-flash-low"
      );

      assert.deepStrictEqual(result, {
        used: 17_000,
        size: 1_000_000,
      });
    });

    test("returns null when Antigravity does not report exact context usage", () => {
      const parser = new AntigravityLogParser();

      const result = parser.extractLiveContextWindow(
        { type: "log.line", line: "heartbeat" },
        "gemini-3.5-flash-low"
      );

      assert.strictEqual(result, null);
    });
  });

  suite("readSessionIdFromLastConversations", () => {
    test("returns the workspace-scoped session ID from the Antigravity cache", async () => {
      await withTemporaryHome(async (homeDir) => {
        const parser = new AntigravityLogParser();
        const workspaceRoot = path.join(homeDir, "workspace");
        const cacheDir = path.join(
          homeDir,
          ".gemini",
          "antigravity-cli",
          "cache"
        );
        const cachePath = path.join(cacheDir, "last_conversations.json");
        const sessionId = "33333333-3333-3333-3333-333333333333";

        fs.mkdirSync(workspaceRoot, { recursive: true });
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(
          cachePath,
          JSON.stringify({
            [path.resolve(workspaceRoot)]: sessionId,
          }),
          "utf8"
        );

        const result =
          await parser.readSessionIdFromLastConversations(workspaceRoot);

        assert.strictEqual(result, sessionId);
      });
    });
  });

  suite("discoverSessionLog", () => {
    test("finds the newest matching CLI log in the Antigravity log directory", async () => {
      await withTemporaryHome(async (homeDir) => {
        const parser = new AntigravityLogParser();
        const logDir = path.join(homeDir, ".gemini", "antigravity-cli", "log");
        const olderLog = path.join(logDir, "cli-20260705_110000.log");
        const newerLog = path.join(logDir, "cli-20260705_120000.log");
        const startTime = new Date("2026-07-05T11:30:00.000Z");

        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(olderLog, "older", "utf8");
        fs.writeFileSync(newerLog, "newer", "utf8");
        fs.utimesSync(olderLog, startTime, startTime);
        fs.utimesSync(
          newerLog,
          new Date(startTime.getTime() + 60_000),
          new Date(startTime.getTime() + 60_000)
        );

        const result = await parser.discoverSessionLog("prompt", startTime);

        assert.strictEqual(result, newerLog);
      });
    });
  });
});
