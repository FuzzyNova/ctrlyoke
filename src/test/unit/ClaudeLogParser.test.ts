import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeLogParser } from "../../core/harness/claude/ClaudeLogParser";

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
      fs.rmSync(testHome, { recursive: true, force: true });
      testHome = undefined;
    }
  });

  test("discovers sessions from the default managed-worktree path", async () => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-claude-home-"));
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
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-claude-home-"));
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
