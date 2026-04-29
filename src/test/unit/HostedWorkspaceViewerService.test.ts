import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import { HostedWorkspaceViewerService } from "../../server/HostedWorkspaceViewerService";

suite("HostedWorkspaceViewerService", () => {
  const tempRoots: string[] = [];

  function createWorkspace(): string {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "fp-ws-viewer-")
    );
    tempRoots.push(workspaceRoot);
    return workspaceRoot;
  }

  teardown(() => {
    for (const workspaceRoot of tempRoots.splice(0)) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
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
      assert.ok(
        firstDir < firstFile,
        "directories should appear before files"
      );
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

    test("maps TypeScript extension to language ID", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "index.ts"), "export const x = 1;");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.readFile("index.ts");

      assert.strictEqual(result.language, "typescript");
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
      fs.writeFileSync(
        path.join(root, "crlf.txt"),
        "line1\r\nline2\r\n"
      );

      const svc = new HostedWorkspaceViewerService(root);
      // Submit content with mixed or LF endings
      await svc.saveFile({ path: "crlf.txt", content: "line1\nline2\n" });

      const written = fs.readFileSync(path.join(root, "crlf.txt"), "utf8");
      assert.ok(written.includes("\r\n"), "should normalise to CRLF");
    });
  });

  // ── getStatus ─────────────────────────────────────────────────────────────

  suite("getStatus", () => {
    test("returns empty files array when not in a git repo", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);

      const result = await svc.getStatus();

      assert.deepStrictEqual(result.files, []);
    });
  });
});
