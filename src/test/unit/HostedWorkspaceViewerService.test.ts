import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import { HostedWorkspaceViewerService } from "../../server/HostedWorkspaceViewerService";
import {
  CommitMessageGenerator,
  type CommitResult,
} from "../../git/CommitMessageGenerator";
import type { WorkspaceSearchContentMatch } from "../../types/HostedWorkspaceViewerTypes";

suite("HostedWorkspaceViewerService", function () {
  // Most tests here shell out to real git (init/config/commit/clone/push/
  // fetch) via execFileSync/execFileAsync rather than mocking it. Process-
  // spawn overhead under full-suite load (this file runs alongside real CLI
  // discovery calls during extension activation) can intermittently push
  // individual tests past the default 2000ms mocha timeout.
  this.timeout(10_000);

  const tempRoots: string[] = [];

  function createWorkspace(): string {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "fp-ws-viewer-")
    );
    tempRoots.push(workspaceRoot);
    return workspaceRoot;
  }

  function runGit(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function configureGitIdentity(cwd: string): void {
    runGit(cwd, "config", "user.name", "ctrlyoke Test");
    runGit(cwd, "config", "user.email", "ctrlyoke@example.com");
  }

  function commitFile(
    cwd: string,
    fileName: string,
    content: string,
    message: string
  ): void {
    fs.writeFileSync(path.join(cwd, fileName), content);
    runGit(cwd, "add", fileName);
    runGit(cwd, "commit", "-m", message);
  }

  teardown(() => {
    for (const workspaceRoot of tempRoots.splice(0)) {
      // Windows can hold transient locks on git pack files (which are also
      // read-only), causing EPERM. maxRetries makes rmSync retry on EPERM.
      try {
        fs.rmSync(workspaceRoot, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      } catch {
        // Best-effort cleanup of OS temp dirs; ignore residual lock failures.
      }
    }
  });

  // ── listDirectory ──────────────────────────────────────────────────────────

  suite("listDirectory", () => {
    test("lists files and directories in workspace root", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "hello.txt"), "hello");
      fs.mkdirSync(path.join(root, "subdir"));

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory("");

      assert.strictEqual(result.path, "");
      assert.strictEqual(result.parentPath, null);
      const names = result.entries.map((e) => e.name);
      assert.ok(names.includes("subdir"), "should include subdirectory");
      assert.ok(names.includes("hello.txt"), "should include file");
    });

    test("returns directories before files", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "alpha.txt"), "a");
      fs.mkdirSync(path.join(root, "zeta"));

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory("");

      const kinds = result.entries.map((e) => e.kind);
      const firstDir = kinds.indexOf("directory");
      const firstFile = kinds.indexOf("file");
      assert.ok(firstDir < firstFile, "directories should appear before files");
    });

    test("returns empty entries for path traversal attempt", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);

      const result = await svc.listDirectory("../escape");

      assert.deepStrictEqual(result.entries, []);
    });

    test("returns parentPath for a subdirectory", async () => {
      const root = createWorkspace();
      fs.mkdirSync(path.join(root, "subdir"));

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory("subdir");

      assert.strictEqual(result.parentPath, "");
    });

    test("rootLabel matches workspace directory name", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory("");

      assert.strictEqual(result.rootLabel, path.basename(root));
    });

    test("isGitRepo is false outside a git repository", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory("");

      assert.strictEqual(result.isGitRepo, false);
    });

    test("marks gitignored files and directories when in a git repository", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      fs.writeFileSync(
        path.join(root, ".gitignore"),
        "ignored.txt\nignored_dir/\n"
      );
      commitFile(root, "tracked.txt", "hello\n", "initial");
      fs.writeFileSync(path.join(root, "ignored.txt"), "secret\n");
      fs.mkdirSync(path.join(root, "ignored_dir"));
      fs.writeFileSync(path.join(root, "ignored_dir", "inner.txt"), "secret\n");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory("");

      assert.strictEqual(result.isGitRepo, true);
      const byName = new Map(result.entries.map((e) => [e.name, e]));
      assert.strictEqual(byName.get("tracked.txt")?.gitIgnored, false);
      assert.strictEqual(byName.get("ignored.txt")?.gitIgnored, true);
      assert.strictEqual(byName.get("ignored_dir")?.gitIgnored, true);
      assert.strictEqual(byName.get(".git")?.gitIgnored, true);
    });
  });

  // ── readFile ───────────────────────────────────────────────────────────────

  suite("readFile", () => {
    test("returns file content for a valid path", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "sample.txt"), "hello world");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.readFile("sample.txt");

      assert.strictEqual(result.readOnly, undefined);
      assert.strictEqual(result.content, "hello world");
      assert.strictEqual(result.name, "sample.txt");
    });

    test("returns readOnly for path traversal attempt", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);

      const result = await svc.readFile("../escape");

      assert.strictEqual(result.readOnly, true);
      assert.ok(result.reason, "should include a reason string");
    });

    test("returns readOnly for absolute path outside workspace", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);

      // Use an absolute path to a system directory
      const outsidePath = os.homedir();
      const result = await svc.readFile(outsidePath);

      assert.strictEqual(result.readOnly, true);
    });

    test("returns readOnly for file not found", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);

      const result = await svc.readFile("nonexistent.txt");

      assert.strictEqual(result.readOnly, true);
      assert.ok(result.reason, "should include a reason string");
    });

    test("detects CRLF line endings", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "crlf.txt"), "line1\r\nline2\r\n");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.readFile("crlf.txt");

      assert.strictEqual(result.readOnly, undefined);
      assert.strictEqual(result.eol, "crlf");
    });

    test("detects LF line endings", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "lf.txt"), "line1\nline2\n");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.readFile("lf.txt");

      assert.strictEqual(result.readOnly, undefined);
      assert.strictEqual(result.eol, "lf");
    });

    test("returns readOnly for binary file", async () => {
      const root = createWorkspace();
      // Write a buffer with a null byte (binary indicator)
      const buf = Buffer.alloc(16);
      buf[4] = 0; // null byte signals binary
      fs.writeFileSync(path.join(root, "binary.bin"), buf);

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.readFile("binary.bin");

      assert.strictEqual(result.readOnly, true);
      assert.strictEqual(result.reason, "Binary file");
    });

    test("returns a data URI for a known image type instead of rejecting it", async () => {
      const root = createWorkspace();
      // PNG magic bytes; readFile doesn't validate the format, only base64-encodes.
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      fs.writeFileSync(path.join(root, "pic.png"), pngBytes);

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.readFile("pic.png");

      assert.strictEqual(result.readOnly, true);
      assert.strictEqual(result.content, "");
      assert.strictEqual(
        result.imageDataUri,
        `data:image/png;base64,${pngBytes.toString("base64")}`
      );
    });

    test("maps TypeScript extension to language ID", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "index.ts"), "export const x = 1;");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.readFile("index.ts");

      assert.strictEqual(result.language, "typescript");
    });
  });

  // ── searchWorkspace ──────────────────────────────────────────────────────

  suite("searchWorkspace", () => {
    test("returns filename and content matches with 1-based line numbers", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      fs.writeFileSync(
        path.join(root, "needle-result.txt"),
        "first line\nneedle on the second line\nneedle again\n"
      );
      fs.writeFileSync(path.join(root, "other.txt"), "needle in content\n");

      const svc = new HostedWorkspaceViewerService(root);
      const filenameResult = await svc.searchWorkspace({
        query: "NEEDLE",
        scope: "files",
      });
      assert.deepStrictEqual(filenameResult.results, [
        { kind: "file", path: "needle-result.txt", name: "needle-result.txt" },
      ]);

      const contentResult = await svc.searchWorkspace({
        query: "needle",
        scope: "content",
      });
      assert.deepStrictEqual(
        contentResult.results
          .filter(
            (result): result is WorkspaceSearchContentMatch =>
              result.kind === "content"
          )
          .map((result) => ({
            path: result.path,
            line: result.line,
            snippet: result.matchSnippet,
          })),
        [
          {
            path: "needle-result.txt",
            line: 2,
            snippet: "needle on the second line",
          },
          { path: "needle-result.txt", line: 3, snippet: "needle again" },
          { path: "other.txt", line: 1, snippet: "needle in content" },
        ]
      );
    });

    test("skips binary and oversized files during content search", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      fs.writeFileSync(
        path.join(root, "binary.dat"),
        Buffer.from([0, ...Buffer.from("needle")])
      );
      fs.writeFileSync(
        path.join(root, "large.txt"),
        Buffer.alloc(2 * 1024 * 1024 + 1, "needle")
      );

      const result = await new HostedWorkspaceViewerService(
        root
      ).searchWorkspace({ query: "needle", scope: "content" });

      assert.deepStrictEqual(result.results, []);
    });

    test("excludes ignored files unless explicitly requested", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
      fs.writeFileSync(path.join(root, "ignored.txt"), "secret needle\n");

      const svc = new HostedWorkspaceViewerService(root);
      const excluded = await svc.searchWorkspace({
        query: "secret",
        scope: "content",
      });
      const included = await svc.searchWorkspace({
        query: "secret",
        scope: "content",
        includeGitIgnored: true,
      });

      assert.deepStrictEqual(excluded.results, []);
      assert.strictEqual(included.results[0]?.path, "ignored.txt");
    });

    test("uses a bounded non-git fallback walk", async () => {
      const root = createWorkspace();
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.writeFileSync(
        path.join(root, "node_modules", "hidden.txt"),
        "fallback needle\n"
      );
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(
        path.join(root, "src", "visible.txt"),
        "fallback needle\n"
      );

      const result = await new HostedWorkspaceViewerService(
        root
      ).searchWorkspace({
        query: "fallback",
        scope: "content",
      });

      assert.deepStrictEqual(
        result.results.map((match) => match.path),
        ["src/visible.txt"]
      );
    });

    test("returns prefixed multi-root paths and scopes by repo", async () => {
      const primary = createWorkspace();
      const secondary = createWorkspace();
      for (const root of [primary, secondary]) {
        runGit(root, "init");
        fs.writeFileSync(path.join(root, "match.txt"), "multi-root needle\n");
      }
      const svc = new HostedWorkspaceViewerService(primary, [
        { name: "primary", fsPath: primary },
        { name: "secondary", fsPath: secondary },
      ]);
      const repos = await svc.getRepos();

      const all = await svc.searchWorkspace({
        query: "multi-root",
        scope: "content",
      });
      const primaryOnly = await svc.searchWorkspace({
        query: "multi-root",
        scope: "content",
        repo: repos.prefixRepoIds.primary,
      });

      assert.deepStrictEqual(all.results.map((result) => result.path).sort(), [
        "primary/match.txt",
        "secondary/match.txt",
      ]);
      assert.deepStrictEqual(
        primaryOnly.results.map((result) => result.path),
        ["primary/match.txt"]
      );
    });

    test("marks the response truncated when the scan file budget is exceeded", async () => {
      const root = createWorkspace();
      for (let i = 0; i < 5001; i++) {
        fs.writeFileSync(path.join(root, `file-${i}.txt`), "contents\n");
      }

      const result = await new HostedWorkspaceViewerService(
        root
      ).searchWorkspace({
        query: "missing",
        scope: "files",
      });

      assert.strictEqual(result.truncated, true);
    });
  });

  // ── saveFile ───────────────────────────────────────────────────────────────

  suite("saveFile", () => {
    test("writes content to an existing file", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "edit.txt"), "original");

      const svc = new HostedWorkspaceViewerService(root);
      await svc.saveFile({ path: "edit.txt", content: "updated" });

      const written = fs.readFileSync(path.join(root, "edit.txt"), "utf8");
      assert.strictEqual(written, "updated");
    });

    test("throws for path traversal attempt", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);

      await assert.rejects(
        () => svc.saveFile({ path: "../escape.txt", content: "pwned" }),
        /Path not allowed/
      );
    });

    test("normalises CRLF content to match original EOL", async () => {
      const root = createWorkspace();
      // Original file uses CRLF
      fs.writeFileSync(path.join(root, "crlf.txt"), "line1\r\nline2\r\n");

      const svc = new HostedWorkspaceViewerService(root);
      // Submit content with mixed or LF endings
      await svc.saveFile({ path: "crlf.txt", content: "line1\nline2\n" });

      const written = fs.readFileSync(path.join(root, "crlf.txt"), "utf8");
      assert.ok(written.includes("\r\n"), "should normalise to CRLF");
    });
  });

  // ── generateCommitMessage ─────────────────────────────────────────────────

  suite("generateCommitMessage", () => {
    const originalGetDiff = CommitMessageGenerator.prototype.getDiff;
    const originalGenerateMessage =
      CommitMessageGenerator.prototype.generateMessage;

    teardown(() => {
      CommitMessageGenerator.prototype.getDiff = originalGetDiff;
      CommitMessageGenerator.prototype.generateMessage =
        originalGenerateMessage;
    });

    test("returns null when getDiff returns null", async () => {
      const root = createWorkspace();
      CommitMessageGenerator.prototype.getDiff = async () => null;

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.generateCommitMessage();

      assert.strictEqual(result, null);
    });

    test("returns CommitResult on success", async () => {
      const root = createWorkspace();
      const expected: CommitResult = {
        message: "feat: add thing",
        staged: true,
        truncated: false,
      };
      CommitMessageGenerator.prototype.getDiff = async () => ({
        diff: "diff --git a/a b/a",
        staged: true,
        truncated: false,
        commands: ["git diff --cached"],
        includesUntrackedFiles: false,
      });
      CommitMessageGenerator.prototype.generateMessage = async () => ({
        message: expected.message,
        prompt: "",
        cliCommand: undefined,
      });

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.generateCommitMessage();

      assert.deepStrictEqual(result, expected);
    });

    test("returns truncated=true when diff was truncated", async () => {
      const root = createWorkspace();
      CommitMessageGenerator.prototype.getDiff = async () => ({
        diff: "diff --git a/a b/a",
        staged: false,
        truncated: true,
        commands: ["git diff --cached", "git diff"],
        includesUntrackedFiles: false,
      });
      CommitMessageGenerator.prototype.generateMessage = async () => ({
        message: "chore: update deps",
        prompt: "",
        cliCommand: undefined,
      });

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.generateCommitMessage();

      assert.ok(result !== null, "result should not be null");
      assert.strictEqual(result.truncated, true);
    });

    test("propagates errors from generate", async () => {
      const root = createWorkspace();
      CommitMessageGenerator.prototype.getDiff = async () => ({
        diff: "diff --git a/a b/a",
        staged: false,
        truncated: false,
        commands: ["git diff --cached", "git diff"],
        includesUntrackedFiles: false,
      });
      CommitMessageGenerator.prototype.generateMessage = async () => {
        throw new Error("generation failed");
      };

      const svc = new HostedWorkspaceViewerService(root);
      await assert.rejects(
        () => svc.generateCommitMessage(),
        /generation failed/
      );
    });
  });

  // ── getStatus ─────────────────────────────────────────────────────────────

  suite("getStatus", () => {
    test("returns empty files array when not in a git repo", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);

      const result = await svc.getStatus();

      assert.deepStrictEqual(result.files, []);
      assert.strictEqual(result.incomingCommitCount, 0);
      assert.strictEqual(result.outgoingCommitCount, 0);
    });

    test("reports outgoing commits relative to the upstream branch", async () => {
      const remoteRoot = createWorkspace();
      const root = createWorkspace();

      runGit(remoteRoot, "init", "--bare");
      runGit(path.dirname(root), "clone", remoteRoot, path.basename(root));
      configureGitIdentity(root);

      commitFile(root, "tracked.txt", "one\n", "initial commit");
      runGit(root, "push", "-u", "origin", "HEAD");

      commitFile(root, "tracked.txt", "two\n", "local commit");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.getStatus();

      assert.strictEqual(result.incomingCommitCount, 0);
      assert.strictEqual(result.outgoingCommitCount, 1);
    });

    test("reports incoming commits after the upstream branch advances", async () => {
      const remoteRoot = createWorkspace();
      const root = createWorkspace();
      const peerRoot = createWorkspace();

      runGit(remoteRoot, "init", "--bare");
      runGit(path.dirname(root), "clone", remoteRoot, path.basename(root));
      configureGitIdentity(root);

      commitFile(root, "tracked.txt", "one\n", "initial commit");
      runGit(root, "push", "-u", "origin", "HEAD");

      runGit(
        path.dirname(peerRoot),
        "clone",
        remoteRoot,
        path.basename(peerRoot)
      );
      configureGitIdentity(peerRoot);
      commitFile(peerRoot, "tracked.txt", "two\n", "remote commit");
      runGit(peerRoot, "push", "origin", "HEAD");

      runGit(root, "fetch", "origin");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.getStatus();

      assert.strictEqual(result.incomingCommitCount, 1);
      assert.strictEqual(result.outgoingCommitCount, 0);
    });

    test("reports untracked files only in the changes area", async () => {
      const root = createWorkspace();

      runGit(root, "init");
      configureGitIdentity(root);
      fs.writeFileSync(path.join(root, "new-file.txt"), "hello\n");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.getStatus();

      assert.strictEqual(result.files.length, 1);
      assert.deepStrictEqual(result.files[0], {
        path: "new-file.txt",
        stagedStatus: null,
        unstagedStatus: "?",
        kind: "untracked",
      });
    });
  });

  // ── getCommitLog ──────────────────────────────────────────────────────────

  suite("getCommitLog", () => {
    test("marks HEAD, parses branch ref labels, and reports the branch", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "a.txt", "one\n", "first");
      commitFile(root, "b.txt", "two\n", "second");
      const branch = runGit(root, "branch", "--show-current");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.getCommitLog();

      assert.strictEqual(result.detached, false);
      assert.strictEqual(result.currentBranch, branch);
      assert.strictEqual(result.commits.length, 2);

      const head = result.commits[0];
      assert.strictEqual(head.subject, "second");
      assert.strictEqual(head.isHead, true);
      assert.strictEqual(head.isMerge, false);
      assert.ok(
        head.refs.some((r) => r.type === "localBranch" && r.name === branch),
        `expected a localBranch ref named ${branch}`
      );
    });

    test("does not duplicate a remote-branch pill for the origin/HEAD alias", async () => {
      const remoteRoot = createWorkspace();
      const root = createWorkspace();

      runGit(remoteRoot, "init", "--bare");
      runGit(path.dirname(root), "clone", remoteRoot, path.basename(root));
      configureGitIdentity(root);

      commitFile(root, "tracked.txt", "one\n", "initial commit");
      runGit(root, "push", "-u", "origin", "HEAD");
      const branch = runGit(root, "branch", "--show-current");
      // git log --decorate then reports both the remote branch and "origin/HEAD"
      // on the same commit.
      runGit(root, "remote", "set-head", "origin", "-a");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.getCommitLog();

      const head = result.commits[0];
      const remoteBranchRefs = head.refs.filter(
        (r) => r.type === "remoteBranch"
      );
      assert.strictEqual(
        remoteBranchRefs.length,
        1,
        `expected exactly one remoteBranch pill, got: ${JSON.stringify(remoteBranchRefs)}`
      );
      assert.strictEqual(remoteBranchRefs[0].name, `origin/${branch}`);
    });

    test("flags merge commits via isMerge", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "base.txt", "base\n", "base");
      const main = runGit(root, "branch", "--show-current");

      runGit(root, "checkout", "-b", "feature");
      commitFile(root, "feature.txt", "feat\n", "feature work");

      runGit(root, "checkout", main);
      commitFile(root, "main.txt", "main\n", "main work");
      runGit(root, "merge", "--no-ff", "-m", "merge feature", "feature");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.getCommitLog();

      const merge = result.commits.find((c) => c.subject === "merge feature");
      assert.ok(merge, "merge commit should be present");
      assert.strictEqual(merge?.isMerge, true);
    });

    test("keeps branch-ahead commits visible while detached when given a branch hint", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "a.txt", "one\n", "older");
      const olderHash = runGit(root, "rev-parse", "HEAD");
      commitFile(root, "b.txt", "two\n", "newer");
      const branch = runGit(root, "branch", "--show-current");

      // Detach onto the older commit.
      runGit(root, "checkout", olderHash);

      const svc = new HostedWorkspaceViewerService(root);

      // Without a hint, the default HEAD log only shows the detached commit.
      const noHint = await svc.getCommitLog();
      assert.strictEqual(noHint.detached, true);
      assert.strictEqual(noHint.currentBranch, null);
      assert.strictEqual(noHint.commits.length, 1);
      assert.strictEqual(noHint.commits[0].subject, "older");

      // With the branch hint, the newer "ahead" commit stays visible and HEAD
      // is still marked on the detached (older) commit.
      const withHint = await svc.getCommitLog(0, 30, branch);
      assert.strictEqual(withHint.commits.length, 2);
      const newer = withHint.commits.find((c) => c.subject === "newer");
      const older = withHint.commits.find((c) => c.subject === "older");
      assert.strictEqual(newer?.isHead, false);
      assert.strictEqual(older?.isHead, true);
    });

    test("ignores an unknown branch hint and falls back to HEAD", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "a.txt", "one\n", "only");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.getCommitLog(0, 30, "no-such-branch");

      assert.strictEqual(result.commits.length, 1);
      assert.strictEqual(result.commits[0].subject, "only");
    });
  });

  // ── multi-root ────────────────────────────────────────────────────────────

  suite("multi-root", () => {
    function createMultiRootService(): {
      svc: HostedWorkspaceViewerService;
      primary: string;
      secondary: string;
    } {
      const primary = createWorkspace();
      const secondary = createWorkspace();
      const svc = new HostedWorkspaceViewerService(primary, [
        { name: "primary", fsPath: primary },
        { name: "secondary", fsPath: secondary },
      ]);
      return { svc, primary, secondary };
    }

    test("listDirectory('') returns a virtual roots list instead of the primary root's contents", async () => {
      const { svc, primary } = createMultiRootService();
      fs.writeFileSync(path.join(primary, "hello.txt"), "hello");

      const result = await svc.listDirectory("");

      assert.strictEqual(result.isRootsList, true);
      assert.strictEqual(result.parentPath, null);
      assert.deepStrictEqual(result.entries.map((e) => e.name).sort(), [
        "primary",
        "secondary",
      ]);
      assert.ok(
        result.entries.every((e) => e.kind === "directory"),
        "every root entry should be a directory"
      );
    });

    test("browsing into a secondary root lists its contents with folder-name-prefixed paths", async () => {
      const { svc, secondary } = createMultiRootService();
      fs.writeFileSync(path.join(secondary, "foo.txt"), "foo");
      fs.mkdirSync(path.join(secondary, "sub"));

      const result = await svc.listDirectory("secondary");

      assert.strictEqual(result.isRootsList, false);
      assert.strictEqual(result.parentPath, "");
      const byName = new Map(result.entries.map((e) => [e.name, e]));
      assert.strictEqual(byName.get("foo.txt")?.path, "secondary/foo.txt");
      assert.strictEqual(byName.get("sub")?.path, "secondary/sub");
    });

    test("readFile resolves a folder-name-prefixed path against the secondary root", async () => {
      const { svc, secondary } = createMultiRootService();
      fs.writeFileSync(path.join(secondary, "note.txt"), "secondary content");

      const result = await svc.readFile("secondary/note.txt");

      assert.strictEqual(result.readOnly, undefined);
      assert.strictEqual(result.content, "secondary content");
      assert.strictEqual(result.path, "secondary/note.txt");
    });

    test("readFile resolves an unprefixed path against the primary root", async () => {
      const { svc, primary } = createMultiRootService();
      fs.writeFileSync(path.join(primary, "note.txt"), "primary content");

      const result = await svc.readFile("note.txt");

      assert.strictEqual(result.content, "primary content");
    });

    test("readFile rejects a path outside every trusted root", async () => {
      const { svc } = createMultiRootService();

      const result = await svc.readFile(os.homedir());

      assert.strictEqual(result.readOnly, true);
    });

    test("saveFile writes into the secondary root via a prefixed path", async () => {
      const { svc, secondary } = createMultiRootService();
      fs.writeFileSync(path.join(secondary, "edit.txt"), "original");

      await svc.saveFile({ path: "secondary/edit.txt", content: "updated" });

      const written = fs.readFileSync(path.join(secondary, "edit.txt"), "utf8");
      assert.strictEqual(written, "updated");
    });

    test("deleteEntry rejects deleting a root folder itself", async () => {
      const { svc } = createMultiRootService();

      await assert.rejects(
        () => svc.deleteEntry("secondary"),
        /Path not allowed/
      );
    });

    test("copyEntry copies a file from the primary root into the secondary root", async () => {
      const { svc, primary, secondary } = createMultiRootService();
      fs.writeFileSync(path.join(primary, "source.txt"), "copy me");

      await svc.copyEntry({ sourcePath: "source.txt", destDir: "secondary" });

      const copied = fs.readFileSync(
        path.join(secondary, "source.txt"),
        "utf8"
      );
      assert.strictEqual(copied, "copy me");
      // Original remains in the primary root.
      assert.ok(fs.existsSync(path.join(primary, "source.txt")));
    });

    test("moveEntry moves a file from the secondary root into the primary root", async () => {
      const { svc, primary, secondary } = createMultiRootService();
      fs.writeFileSync(path.join(secondary, "move-me.txt"), "moved content");

      await svc.moveEntry({ sourcePath: "secondary/move-me.txt", destDir: "" });

      assert.ok(fs.existsSync(path.join(primary, "move-me.txt")));
      assert.ok(!fs.existsSync(path.join(secondary, "move-me.txt")));
    });

    test("getStatus prefixes changed-file paths with the primary root's folder name", async () => {
      const { svc, primary } = createMultiRootService();
      runGit(primary, "init");
      configureGitIdentity(primary);
      fs.writeFileSync(path.join(primary, "new-file.txt"), "hello\n");

      const result = await svc.getStatus();

      assert.strictEqual(result.files.length, 1);
      assert.strictEqual(result.files[0].path, "primary/new-file.txt");
    });

    test("stageFile accepts the getStatus-prefixed path and stages the primary-root file", async () => {
      const { svc, primary } = createMultiRootService();
      runGit(primary, "init");
      configureGitIdentity(primary);
      fs.writeFileSync(path.join(primary, "staged.txt"), "hello\n");

      await svc.stageFile("primary/staged.txt");

      const staged = runGit(primary, "diff", "--cached", "--name-only");
      assert.strictEqual(staged, "staged.txt");
    });

    test("stageFile rejects a secondary-root path when that root is not a git repo", async () => {
      const { svc, primary, secondary } = createMultiRootService();
      runGit(primary, "init");
      configureGitIdentity(primary);
      fs.writeFileSync(path.join(secondary, "other.txt"), "hello\n");

      await assert.rejects(
        () => svc.stageFile("secondary/other.txt"),
        /not inside a git repository/
      );
    });

    test("getStatus aggregates changes across every repo in a multi-repo workspace", async () => {
      const { svc, primary, secondary } = createMultiRootService();
      for (const root of [primary, secondary]) {
        runGit(root, "init");
        configureGitIdentity(root);
      }
      fs.writeFileSync(path.join(primary, "p.txt"), "p\n");
      fs.writeFileSync(path.join(secondary, "s.txt"), "s\n");

      const result = await svc.getStatus();

      assert.deepStrictEqual(result.files.map((f) => f.path).sort(), [
        "primary/p.txt",
        "secondary/s.txt",
      ]);
    });

    test("getStatus scoped to a repo id reports only that repo's changes", async () => {
      const { svc, primary, secondary } = createMultiRootService();
      for (const root of [primary, secondary]) {
        runGit(root, "init");
        configureGitIdentity(root);
      }
      fs.writeFileSync(path.join(primary, "p.txt"), "p\n");
      fs.writeFileSync(path.join(secondary, "s.txt"), "s\n");

      const repos = (await svc.getRepos()).repos;
      const secondaryRepo = repos.find((r) => r.label === "secondary");
      assert.ok(secondaryRepo, "expected a repo labeled 'secondary'");

      const result = await svc.getStatus(secondaryRepo.id);

      assert.deepStrictEqual(
        result.files.map((f) => f.path),
        ["secondary/s.txt"]
      );
    });

    test("stageFile stages a file in a secondary root that is its own git repo", async () => {
      const { svc, primary, secondary } = createMultiRootService();
      for (const root of [primary, secondary]) {
        runGit(root, "init");
        configureGitIdentity(root);
      }
      fs.writeFileSync(path.join(secondary, "other.txt"), "hello\n");

      await svc.stageFile("secondary/other.txt");

      const staged = runGit(secondary, "diff", "--cached", "--name-only");
      assert.strictEqual(staged, "other.txt");
    });

    test("getRepos discovers one entry per repo and dedupes roots sharing a repo", async () => {
      const { svc, primary } = createMultiRootService();
      runGit(primary, "init");
      configureGitIdentity(primary);
      // secondary is left as a non-repo directory.

      const result = await svc.getRepos();

      assert.strictEqual(result.repos.length, 1);
      assert.strictEqual(result.repos[0].label, "primary");
      // The prefix map covers the git root and omits the non-repo root, so the
      // client can follow the open file without guessing from labels/ids.
      assert.deepStrictEqual(result.prefixRepoIds, {
        primary: result.repos[0].id,
      });
    });

    test("single-root behavior is unchanged when namedRoots has 0 or 1 entries", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "hello.txt"), "hello");
      const svcNoRoots = new HostedWorkspaceViewerService(root);
      const svcOneRoot = new HostedWorkspaceViewerService(root, [
        { name: path.basename(root), fsPath: root },
      ]);

      for (const svc of [svcNoRoots, svcOneRoot]) {
        const result = await svc.listDirectory("");
        assert.strictEqual(result.isRootsList, false);
        assert.strictEqual(result.parentPath, null);
        assert.ok(result.entries.some((e) => e.name === "hello.txt"));
      }
    });
  });

  // ── getWorktreeDiff ─────────────────────────────────────────────────────────

  suite("getWorktreeDiff", () => {
    test("diffs a recorded worktree branch against its recorded base commit", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "base.txt", "base\n", "base commit");
      const baseCommit = runGit(root, "rev-parse", "HEAD");
      runGit(root, "checkout", "-b", "feature/worktree-test");
      commitFile(root, "feature.txt", "feature\n", "feature commit");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.getWorktreeDiff(
        root,
        baseCommit,
        "feature/worktree-test"
      );

      assert.ok(result.unifiedDiff.includes("feature.txt"));
    });

    test("rejects a sourceCheckoutRoot outside every discovered repo", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "base.txt", "base\n", "base commit");
      const baseCommit = runGit(root, "rev-parse", "HEAD");
      const outside = createWorkspace();

      const svc = new HostedWorkspaceViewerService(root);

      await assert.rejects(
        () => svc.getWorktreeDiff(outside, baseCommit, "main"),
        /not inside a git repository/
      );
    });
  });
});
