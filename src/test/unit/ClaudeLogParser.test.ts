import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import { ClaudeLogParser } from "../../core/harness/claude/ClaudeLogParser";
import { BaseCliEvent } from "../../core/harness/shared/interfaces/ILogParser";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("ClaudeLogParser", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let testHome: string | undefined;

  teardown(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (testHome) {
      removeTempDir(testHome);
      testHome = undefined;
    }
  });

  test("ignores synthetic assistant usage when computing step context", () => {
    const parser = new ClaudeLogParser();
    const events: BaseCliEvent[] = [
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 150000,
            cache_creation_input_tokens: 0,
            output_tokens: 200,
          },
          content: [{ type: "text", text: "A real response." }],
        },
      },
      {
        type: "assistant",
        message: {
          model: "<synthetic>",
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
          stop_reason: "stop_sequence",
          content: [
            {
              type: "text",
              text: "API Error: Server error mid-response. The response above may be incomplete.",
            },
          ],
        },
      },
    ];

    const result = parser.extractResponse(events);

    assert.strictEqual(result.metadata.model, "claude-opus-4-6");
    assert.strictEqual(result.metadata.usage?.contextWindowUsedTokens, 151000);
    assert.ok(
      result.events.some(
        (event) =>
          event.type === CLI_EVENT_TYPES.TEXT &&
          "text" in event.data &&
          event.data.text.includes("API Error: Server error mid-response")
      )
    );
  });

  test("does not resolve the model from a leading synthetic assistant event", () => {
    const parser = new ClaudeLogParser();
    const events: BaseCliEvent[] = [
      {
        type: "assistant",
        message: {
          model: "<synthetic>",
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
          content: [{ type: "text", text: "API Error." }],
        },
      },
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 150000,
            cache_creation_input_tokens: 0,
            output_tokens: 200,
          },
          content: [{ type: "text", text: "A real response." }],
        },
      },
    ];

    const result = parser.extractResponse(events);

    assert.strictEqual(result.metadata.model, "claude-opus-4-6");
  });

  test("ignores synthetic assistant usage in live context updates", () => {
    const parser = new ClaudeLogParser();
    const result = parser.extractLiveContextWindow(
      {
        type: "assistant",
        message: {
          model: "<synthetic>",
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
      "claude-opus-4-6"
    );

    assert.strictEqual(result, null);
  });

  test("discovers sessions from the default managed-worktree path", async () => {
    testHome = makeTempDir("ctrlyoke-claude-home-");
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;

    const workspaceRoot = path.win32.join(
      "C:\\",
      "dev",
      "ctrlyoke.worktrees",
      "change-landing-page-tagline-b0aaa9879c27"
    );
    const sessionId = "40a07a85-bc76-47d7-a044-070fa9fcfa9f";
    const projectDirectory = path.join(
      testHome,
      ".claude",
      "projects",
      "C--dev-ctrlyoke-worktrees-change-landing-page-tagline-b0aaa9879c27"
    );
    const sessionPath = path.join(projectDirectory, `${sessionId}.jsonl`);
    fs.mkdirSync(projectDirectory, { recursive: true });
    fs.writeFileSync(sessionPath, '{"type":"user"}\n', "utf8");

    const parser = new ClaudeLogParser();
    parser.setWorkspaceRoot(workspaceRoot);

    assert.strictEqual(
      await parser.discoverSessionLog(
        "prompt",
        new Date(Date.now() - 1_000),
        sessionId
      ),
      sessionPath
    );
  });

  test("discovers a resumed session in its original worktree project", async () => {
    testHome = makeTempDir("ctrlyoke-claude-home-");
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;

    const sessionId = "85a2a7e7-5665-4b50-b5a3-be46d146abab";
    const originalProjectDirectory = path.join(
      testHome,
      ".claude",
      "projects",
      "C--dev-ctrlyoke-worktrees-bug-fix"
    );
    const sessionPath = path.join(
      originalProjectDirectory,
      `${sessionId}.jsonl`
    );
    fs.mkdirSync(originalProjectDirectory, { recursive: true });
    fs.writeFileSync(sessionPath, '{"type":"user"}\n', "utf8");

    const parser = new ClaudeLogParser();
    parser.setWorkspaceRoot(path.win32.join("C:\\", "dev", "ctrlyoke"));

    assert.strictEqual(
      await parser.discoverSessionLog(
        "prompt",
        new Date(Date.now() - 1_000),
        sessionId
      ),
      sessionPath
    );
  });
});
