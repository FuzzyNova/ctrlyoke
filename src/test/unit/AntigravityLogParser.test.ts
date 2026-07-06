import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { AntigravityLogParser } from "../../core/harness/antigravity/AntigravityLogParser";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
} from "../../types/DashboardConstants";

async function withTemporaryHome<T>(
  run: (homeDir: string) => Promise<T> | T
): Promise<T> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-agy-home-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  try {
    return await run(tempHome);
  } finally {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

suite("AntigravityLogParser", () => {
  suite("readNewLines", () => {
    test("parses session and completion markers from plain text logs", async () => {
      const parser = new AntigravityLogParser();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-agy-log-"));
      const logPath = path.join(tempDir, "cli-20260705_120000.log");
      const sessionId = "11111111-1111-1111-1111-111111111111";

      try {
        fs.writeFileSync(
          logPath,
          [
            `Starting conversation update stream for ${sessionId}`,
            "regular log line",
            "clearing ResponsePending",
          ].join("\n"),
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
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
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
        },
      ]);

      assert.strictEqual(
        result.metadata.usage?.contextWindowUsedTokens,
        42
      );
      assert.strictEqual(result.metadata.usage?.contextWindowSize, 1_000_000);
      assert.strictEqual(result.metadata.usage?.inputTokens, 39);
      assert.strictEqual(result.metadata.usage?.outputTokens, 3);
      assert.strictEqual(result.metadata.usage?.totalTokens, 42);
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

  suite("getFinalEventsOnCompletion", () => {
    test("reads the latest model response from the Antigravity transcript", async () => {
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
          [
            JSON.stringify({
              source: "USER_EXPLICIT",
              type: "USER_INPUT",
              status: "DONE",
              content: "question",
            }),
            JSON.stringify({
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "first answer",
            }),
            JSON.stringify({
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              status: "DONE",
              created_at: "2026-07-05T12:00:01Z",
              content: "final answer",
            }),
          ].join("\n"),
          "utf8"
        );

        const events = await parser.getFinalEventsOnCompletion(logPath);

        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].type, "response.text");
        assert.strictEqual(events[0].line, "final answer");
        assert.strictEqual(events[0].sessionId, sessionId);
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
        "Gemini 3.5 Flash (Low)"
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
        "Gemini 3.5 Flash (Low)"
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

        const result = await parser.readSessionIdFromLastConversations(
          workspaceRoot
        );

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
        fs.utimesSync(newerLog, new Date(startTime.getTime() + 60_000), new Date(startTime.getTime() + 60_000));

        const result = await parser.discoverSessionLog("prompt", startTime);

        assert.strictEqual(result, newerLog);
      });
    });
  });
});
