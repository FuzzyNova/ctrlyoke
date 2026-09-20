import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { QwenLogParser } from "../../core/harness/qwen/QwenLogParser";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("QwenLogParser session discovery", () => {
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

  test("discovers a resumed session in its original worktree project", async () => {
    testHome = makeTempDir("ctrlyoke-qwen-home-");
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;

    const sessionId = "qwen-session-from-original-worktree";
    const originalChatsDirectory = path.join(
      testHome,
      ".qwen",
      "projects",
      "c--dev-ctrlyoke-worktrees-bug-fix",
      "chats"
    );
    const sessionPath = path.join(originalChatsDirectory, `${sessionId}.jsonl`);
    fs.mkdirSync(originalChatsDirectory, { recursive: true });
    fs.writeFileSync(sessionPath, '{"type":"user"}\n', "utf8");

    const parser = new QwenLogParser();
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
