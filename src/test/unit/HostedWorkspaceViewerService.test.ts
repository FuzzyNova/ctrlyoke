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
import {
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
  type WorkspaceSearchContentMatch,
} from "../../types/HostedWorkspaceViewerTypes";
import {
  WorkspaceTreeBadRequestError,
  WorkspaceTreeExpiredError,
} from "../../server/WorkspaceTreeErrors";
import { DIFF_PAYLOAD_KINDS } from "../../types/DashboardConstants";

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
      const result = await svc.listDirectory({
        path: "",
        includeGitIgnored: true,
      });

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
      const result = await svc.listDirectory({
        path: "",
        includeGitIgnored: true,
      });

      const kinds = result.entries.map((e) => e.kind);
      const firstDir = kinds.indexOf("directory");
      const firstFile = kinds.indexOf("file");
      assert.ok(firstDir < firstFile, "directories should appear before files");
    });

    test("returns file and directory modification metadata", async () => {
      const root = createWorkspace();
      const directory = path.join(root, "directory");
      const file = path.join(root, "file.txt");
      fs.mkdirSync(directory);
      fs.writeFileSync(file, "content");
      fs.utimesSync(directory, new Date(1000), new Date(2000));
      fs.utimesSync(file, new Date(3000), new Date(4000));

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory({
        path: "",
        pageSize: 2,
        includeGitIgnored: true,
      });
      const byName = new Map(
        result.entries.map((entry) => [entry.name, entry])
      );

      assert.strictEqual(byName.get("directory")?.size, undefined);
      assert.ok(
        Math.abs((byName.get("directory")?.modifiedAt ?? 0) - 2000) < 100
      );
      assert.strictEqual(byName.get("file.txt")?.size, 7);
      assert.ok(
        Math.abs((byName.get("file.txt")?.modifiedAt ?? 0) - 4000) < 100
      );
    });

    test("keeps all four orders globally stable across page boundaries", async () => {
      const root = createWorkspace();
      for (const directory of ["a-directory", "z-directory"]) {
        fs.mkdirSync(path.join(root, directory));
      }
      for (const file of ["a-file.txt", "z-file.txt"]) {
        fs.writeFileSync(path.join(root, file), "x");
      }
      fs.utimesSync(
        path.join(root, "a-directory"),
        new Date(1000),
        new Date(1000)
      );
      fs.utimesSync(
        path.join(root, "z-directory"),
        new Date(2000),
        new Date(2000)
      );
      fs.utimesSync(
        path.join(root, "a-file.txt"),
        new Date(1000),
        new Date(1000)
      );
      fs.utimesSync(
        path.join(root, "z-file.txt"),
        new Date(2000),
        new Date(2000)
      );

      const svc = new HostedWorkspaceViewerService(root);
      const expected = new Map([
        [
          `${WORKSPACE_ENTRY_SORT_KEYS.NAME}:${WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING}`,
          ["a-directory", "z-directory", "a-file.txt", "z-file.txt"],
        ],
        [
          `${WORKSPACE_ENTRY_SORT_KEYS.NAME}:${WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING}`,
          ["z-directory", "a-directory", "z-file.txt", "a-file.txt"],
        ],
        [
          `${WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT}:${WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING}`,
          ["z-directory", "a-directory", "z-file.txt", "a-file.txt"],
        ],
        [
          `${WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT}:${WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING}`,
          ["a-directory", "z-directory", "a-file.txt", "z-file.txt"],
        ],
      ]);
      for (const [key, names] of expected) {
        const [sortKey, direction] = key.split(":") as [
          (typeof WORKSPACE_ENTRY_SORT_KEYS)[keyof typeof WORKSPACE_ENTRY_SORT_KEYS],
          (typeof WORKSPACE_ENTRY_SORT_DIRECTIONS)[keyof typeof WORKSPACE_ENTRY_SORT_DIRECTIONS],
        ];
        const first = await svc.listDirectory({
          path: "",
          pageSize: 1,
          includeGitIgnored: true,
          sort: { key: sortKey, direction },
        });
        const all = [...first.entries];
        for (
          let offset = first.pageSize;
          offset < first.totalEntries;
          offset++
        ) {
          all.push(
            ...(await svc.listDirectory({ listingId: first.listingId, offset }))
              .entries
          );
        }
        assert.deepStrictEqual(
          all.map((entry) => entry.name),
          names
        );
      }
    });

    test("returns metadata for virtual roots using their backing paths", async () => {
      const primary = createWorkspace();
      const secondary = createWorkspace();
      fs.utimesSync(primary, new Date(1000), new Date(1000));
      fs.utimesSync(secondary, new Date(2000), new Date(2000));
      const svc = new HostedWorkspaceViewerService(primary, [
        { name: "display-primary", fsPath: primary },
        { name: "display-secondary", fsPath: secondary },
      ]);

      const result = await svc.listDirectory({
        path: "",
        pageSize: 2,
        includeGitIgnored: true,
        sort: {
          key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
          direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING,
        },
      });

      assert.deepStrictEqual(
        result.entries.map((entry) => entry.name),
        ["display-primary", "display-secondary"]
      );
      assert.ok(
        result.entries.every((entry) => entry.modifiedAt !== undefined)
      );
      assert.ok(result.entries.every((entry) => entry.size === undefined));
    });

    test("caches failed metadata and does not retry it for ranges", async () => {
      const root = createWorkspace();
      const file = path.join(root, "file.txt");
      fs.writeFileSync(file, "content");
      const originalStat = fs.promises.stat;
      let attempts = 0;
      fs.promises.stat = (async (...args: Parameters<typeof originalStat>) => {
        if (args[0] === file) {
          attempts++;
          throw new Error("stat failed");
        }
        return originalStat(...args);
      }) as typeof originalStat;
      try {
        const svc = new HostedWorkspaceViewerService(root);
        const first = await svc.listDirectory({
          path: "",
          pageSize: 1,
          includeGitIgnored: true,
        });
        assert.strictEqual(first.entries[0]?.modifiedAt, undefined);
        const repeated = await svc.listDirectory({
          listingId: first.listingId,
          offset: 0,
        });
        assert.strictEqual(repeated.entries[0]?.size, undefined);
        assert.strictEqual(attempts, 1);
      } finally {
        fs.promises.stat = originalStat;
      }
    });

    test("returns empty entries for path traversal attempt", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);

      await assert.rejects(
        svc.listDirectory({ path: "../escape", includeGitIgnored: true })
      );
    });

    test("returns parentPath for a subdirectory", async () => {
      const root = createWorkspace();
      fs.mkdirSync(path.join(root, "subdir"));

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory({
        path: "subdir",
        includeGitIgnored: true,
      });

      assert.strictEqual(result.parentPath, "");
    });

    test("rootLabel matches workspace directory name", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory({
        path: "",
        includeGitIgnored: true,
      });

      assert.strictEqual(result.rootLabel, path.basename(root));
    });

    test("isGitRepo is false outside a git repository", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory({
        path: "",
        includeGitIgnored: true,
      });

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
      const result = await svc.listDirectory({
        path: "",
        includeGitIgnored: true,
      });

      assert.strictEqual(result.isGitRepo, true);
      const byName = new Map(result.entries.map((e) => [e.name, e]));
      assert.strictEqual(byName.get("tracked.txt")?.gitIgnored, false);
      assert.strictEqual(byName.get("ignored.txt")?.gitIgnored, true);
      assert.strictEqual(byName.get("ignored_dir")?.gitIgnored, true);
      assert.strictEqual(byName.get(".git")?.gitIgnored, true);
    });

    test("makes every entry beyond the old 1,000-entry cutoff reachable", async () => {
      const root = createWorkspace();
      for (let index = 0; index < 1_005; index++) {
        fs.writeFileSync(
          path.join(root, `file-${String(index).padStart(4, "0")}.txt`),
          "x"
        );
      }
      const svc = new HostedWorkspaceViewerService(root);
      const first = await svc.listDirectory({
        path: "",
        pageSize: 100,
        includeGitIgnored: true,
      });
      const entries = [...first.entries];
      for (
        let offset = first.pageSize;
        offset < first.totalEntries;
        offset += first.pageSize
      ) {
        const page = await svc.listDirectory({
          listingId: first.listingId,
          offset,
        });
        entries.push(...page.entries);
      }
      assert.strictEqual(first.totalEntries, 1_005);
      assert.strictEqual(entries.length, 1_005);
      assert.strictEqual(
        new Set(entries.map((entry) => entry.path)).size,
        1_005
      );
      assert.strictEqual(entries.at(-1)?.name, "file-1004.txt");
    });

    test("uses the specified 250-entry default page size", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);

      const result = await svc.listDirectory({
        path: "",
        includeGitIgnored: true,
      });

      assert.strictEqual(result.pageSize, 250);
    });

    test("keeps directories before files across page boundaries", async () => {
      const root = createWorkspace();
      fs.mkdirSync(path.join(root, "z-directory"));
      fs.mkdirSync(path.join(root, "a-directory"));
      for (let index = 0; index < 101; index++) {
        fs.writeFileSync(
          path.join(root, `file-${String(index).padStart(3, "0")}.txt`),
          "x"
        );
      }
      const svc = new HostedWorkspaceViewerService(root);
      const first = await svc.listDirectory({
        path: "",
        pageSize: 1,
        includeGitIgnored: true,
      });
      const all = [first.entries[0]];
      for (let offset = 1; offset < first.totalEntries; offset++) {
        all.push(
          ...(await svc.listDirectory({ listingId: first.listingId, offset }))
            .entries
        );
      }
      assert.deepStrictEqual(
        all.slice(0, 2).map((entry) => entry.name),
        ["a-directory", "z-directory"]
      );
      assert.ok(all.slice(0, 2).every((entry) => entry.kind === "directory"));
      assert.ok(all.slice(2).every((entry) => entry.kind === "file"));
    });

    test("anchors an initial page to an immediate child", async () => {
      const root = createWorkspace();
      for (let index = 0; index < 30; index++) {
        fs.writeFileSync(
          path.join(root, `file-${String(index).padStart(2, "0")}.txt`),
          "x"
        );
      }
      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.listDirectory({
        path: "",
        pageSize: 10,
        includeGitIgnored: true,
        anchorPath: "file-23.txt",
      });
      assert.strictEqual(result.offset, 20);
      assert.strictEqual(result.entries[0]?.name, "file-20.txt");
      assert.ok(result.entries.some((entry) => entry.name === "file-23.txt"));
    });

    test("filters ignored entries before counting and paging", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      fs.writeFileSync(path.join(root, ".gitignore"), "ignored-*.txt\n");
      for (const name of ["ignored-a.txt", "ignored-b.txt", "visible.txt"]) {
        fs.writeFileSync(path.join(root, name), "x");
      }
      const svc = new HostedWorkspaceViewerService(root);
      const hidden = await svc.listDirectory({
        path: "",
        pageSize: 1,
        includeGitIgnored: false,
      });
      const shown = await svc.listDirectory({
        path: "",
        pageSize: 1,
        includeGitIgnored: true,
      });
      assert.strictEqual(hidden.totalEntries, 2);
      assert.deepStrictEqual(
        hidden.entries.map((entry) => entry.name),
        [".gitignore"]
      );
      const hiddenSecondPage = await svc.listDirectory({
        listingId: hidden.listingId,
        offset: 1,
      });
      assert.deepStrictEqual(
        hiddenSecondPage.entries.map((entry) => entry.name),
        ["visible.txt"]
      );
      assert.strictEqual(shown.totalEntries, 5);
    });

    test("keeps a snapshot stable while a refreshed listing sees mutations", async () => {
      const root = createWorkspace();
      fs.writeFileSync(path.join(root, "a.txt"), "a");
      const svc = new HostedWorkspaceViewerService(root);
      const snapshot = await svc.listDirectory({
        path: "",
        pageSize: 1,
        includeGitIgnored: true,
      });
      fs.writeFileSync(path.join(root, "b.txt"), "b");
      fs.rmSync(path.join(root, "a.txt"));
      const oldPage = await svc.listDirectory({
        listingId: snapshot.listingId,
        offset: 0,
      });
      const refreshed = await svc.listDirectory({
        path: "",
        pageSize: 1,
        includeGitIgnored: true,
      });
      assert.deepStrictEqual(
        oldPage.entries.map((entry) => entry.name),
        ["a.txt"]
      );
      assert.deepStrictEqual(
        refreshed.entries.map((entry) => entry.name),
        ["b.txt"]
      );
    });

    test("clamps page size and rejects malformed or expired ranges", async () => {
      const root = createWorkspace();
      for (let index = 0; index < 3; index++) {
        fs.writeFileSync(path.join(root, `file-${index}.txt`), "x");
      }
      const svc = new HostedWorkspaceViewerService(root);
      const listing = await svc.listDirectory({
        path: "",
        pageSize: 999,
        includeGitIgnored: true,
      });
      assert.strictEqual(listing.pageSize, 500);
      await assert.rejects(
        svc.listDirectory({ listingId: listing.listingId, offset: 1 }),
        (error: unknown) => error instanceof WorkspaceTreeBadRequestError
      );
      await assert.rejects(
        svc.listDirectory({
          listingId: "00000000-0000-4000-8000-000000000099",
          offset: 0,
        }),
        (error: unknown) => error instanceof WorkspaceTreeExpiredError
      );
      await assert.rejects(
        svc.listDirectory({ listingId: "not-an-id", offset: 0 }),
        (error: unknown) => error instanceof WorkspaceTreeBadRequestError
      );
    });

    test("bounds file stat concurrency to the named worker limit", async () => {
      const root = createWorkspace();
      for (let index = 0; index < 40; index++) {
        fs.writeFileSync(path.join(root, `file-${index}.txt`), "x");
      }
      const originalStat = fs.promises.stat;
      let active = 0;
      let maximum = 0;
      fs.promises.stat = (async (...args: Parameters<typeof originalStat>) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        try {
          return await originalStat(...args);
        } finally {
          active--;
        }
      }) as typeof originalStat;
      try {
        const svc = new HostedWorkspaceViewerService(root);
        await svc.listDirectory({
          path: "",
          pageSize: 40,
          includeGitIgnored: true,
        });
        assert.ok(maximum <= 8, `stat concurrency was ${maximum}`);
      } finally {
        fs.promises.stat = originalStat;
      }
    });

    test("uses the same page contract for multi-root virtual listings", async () => {
      const primary = createWorkspace();
      const secondary = createWorkspace();
      const svc = new HostedWorkspaceViewerService(primary, [
        { name: "primary", fsPath: primary },
        { name: "secondary", fsPath: secondary },
      ]);
      const first = await svc.listDirectory({
        path: "",
        pageSize: 1,
        includeGitIgnored: true,
      });
      const second = await svc.listDirectory({
        listingId: first.listingId,
        offset: 1,
      });
      assert.strictEqual(first.isRootsList, true);
      assert.strictEqual(first.totalEntries, 2);
      assert.strictEqual(second.entries[0]?.path, "secondary");
    });

    test("clears listing snapshots on request and disposal", async () => {
      const root = createWorkspace();
      const svc = new HostedWorkspaceViewerService(root);
      const listing = await svc.listDirectory({
        path: "",
        includeGitIgnored: true,
      });
      svc.clear();
      await assert.rejects(
        svc.listDirectory({ listingId: listing.listingId, offset: 0 }),
        (error: unknown) => error instanceof WorkspaceTreeExpiredError
      );
      const fresh = await svc.listDirectory({
        path: "",
        includeGitIgnored: true,
      });
      svc.dispose();
      await assert.rejects(
        svc.listDirectory({ listingId: fresh.listingId, offset: 0 }),
        (error: unknown) => error instanceof WorkspaceTreeExpiredError
      );
    });
  });

  // ── getFileHistory ────────────────────────────────────────────────────────

  suite("getFileHistory", () => {
    test("freezes the complete history at the initial HEAD", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "history.txt", "one\n", "First history commit");
      commitFile(root, "history.txt", "two\n", "Second history commit");
      commitFile(root, "history.txt", "three\n", "Third history commit");

      const svc = new HostedWorkspaceViewerService(root);
      const first = await svc.getFileHistory("history.txt", 0, 2);
      assert.deepStrictEqual(
        first.entries.map((entry) => entry.subject),
        ["Third history commit", "Second history commit"]
      );

      commitFile(root, "history.txt", "four\n", "Commit after opening history");
      const continuation = await svc.getFileHistory(
        "history.txt",
        2,
        undefined,
        first.historyId
      );
      assert.strictEqual(continuation.totalEntries, 3);
      assert.deepStrictEqual(
        continuation.entries.map((entry) => entry.subject),
        ["First history commit"]
      );

      const refreshed = await svc.getFileHistory("history.txt", 0, 10);
      assert.strictEqual(refreshed.totalEntries, 4);
      assert.notStrictEqual(refreshed.historyId, first.historyId);
    });

    test("scopes a multi-repo path through its owning repository", async () => {
      const primary = createWorkspace();
      const secondary = createWorkspace();
      for (const root of [primary, secondary]) {
        runGit(root, "init");
        configureGitIdentity(root);
      }
      commitFile(secondary, "history.txt", "secondary\n", "Secondary history");

      const svc = new HostedWorkspaceViewerService(primary, [
        { name: "primary", fsPath: primary },
        { name: "secondary", fsPath: secondary },
      ]);
      const result = await svc.getFileHistory("secondary/history.txt", 0, 2);

      assert.strictEqual(result.totalEntries, 1);
      assert.strictEqual(result.entries[0]?.subject, "Secondary history");
      assert.strictEqual(result.entries[0]?.path, "secondary/history.txt");
    });

    test("rejects invalid paths, history ids, and page ranges", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "history.txt", "one\n", "History commit");
      const svc = new HostedWorkspaceViewerService(root);
      const page = await svc.getFileHistory("history.txt", 0, 2);

      await assert.rejects(
        svc.getFileHistory("../outside.txt"),
        (error: unknown) =>
          error instanceof Error && error.message === "Path not allowed"
      );
      await assert.rejects(
        svc.getFileHistory("history.txt", 1, undefined, page.historyId),
        (error: unknown) => error instanceof WorkspaceTreeBadRequestError
      );
      await assert.rejects(
        svc.getFileHistory(
          "history.txt",
          0,
          undefined,
          "00000000-0000-4000-8000-000000000099"
        ),
        (error: unknown) => error instanceof WorkspaceTreeExpiredError
      );
    });
  });

  // ── getFileHistoryDiff ────────────────────────────────────────────────────

  suite("getFileHistoryDiff", () => {
    test("returns before and after text for a normal file change", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "history.txt", "before\n", "Initial file");
      fs.writeFileSync(path.join(root, "history.txt"), "after\n");
      runGit(root, "add", "history.txt");
      runGit(root, "commit", "-m", "Update file");
      const commit = runGit(root, "rev-parse", "HEAD");

      const result = await new HostedWorkspaceViewerService(
        root
      ).getFileHistoryDiff("history.txt", commit);

      assert.strictEqual(result.payloadKind, "text");
      if (result.payloadKind !== "text") return;
      assert.strictEqual(result.subject, "Update file");
      assert.strictEqual(result.oldContent, "before\n");
      assert.strictEqual(result.newContent, "after\n");
      assert.strictEqual(result.path, "history.txt");
      assert.strictEqual(result.oldPath, "history.txt");
    });

    test("uses the parent path on the old side of a rename", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "old-name.txt", "same content\n", "Initial name");
      runGit(root, "mv", "old-name.txt", "new-name.txt");
      runGit(root, "commit", "-m", "Rename file");
      const commit = runGit(root, "rev-parse", "HEAD");

      const result = await new HostedWorkspaceViewerService(
        root
      ).getFileHistoryDiff("new-name.txt", commit);

      assert.strictEqual(result.payloadKind, "text");
      if (result.payloadKind !== "text") return;
      assert.strictEqual(result.path, "new-name.txt");
      assert.strictEqual(result.oldPath, "old-name.txt");
      assert.strictEqual(result.oldContent, "same content\n");
      assert.strictEqual(result.newContent, "same content\n");
    });

    test("uses Git's implicit empty tree for a root commit", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "root.txt", "root content\n", "Root commit");
      const commit = runGit(root, "rev-parse", "HEAD");

      const result = await new HostedWorkspaceViewerService(
        root
      ).getFileHistoryDiff("root.txt", commit);

      assert.strictEqual(result.payloadKind, "text");
      if (result.payloadKind !== "text") return;
      assert.strictEqual(result.oldContent, "");
      assert.strictEqual(result.newContent, "root content\n");
    });

    test("returns real image bytes for an image-file commit", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      const oldBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
      const newBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
      fs.writeFileSync(path.join(root, "history.png"), oldBytes);
      runGit(root, "add", "history.png");
      runGit(root, "commit", "-m", "Initial image");
      fs.writeFileSync(path.join(root, "history.png"), newBytes);
      runGit(root, "add", "history.png");
      runGit(root, "commit", "-m", "Update image");
      const commit = runGit(root, "rev-parse", "HEAD");

      const result = await new HostedWorkspaceViewerService(
        root
      ).getFileHistoryDiff("history.png", commit);

      assert.strictEqual(result.payloadKind, DIFF_PAYLOAD_KINDS.IMAGE);
      if (result.payloadKind !== DIFF_PAYLOAD_KINDS.IMAGE) return;
      assert.strictEqual(
        result.image.oldImageDataUri,
        `data:image/png;base64,${oldBytes.toString("base64")}`
      );
      assert.strictEqual(
        result.image.newImageDataUri,
        `data:image/png;base64,${newBytes.toString("base64")}`
      );
    });

    test("returns a binary payload for a non-image binary commit", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      fs.writeFileSync(path.join(root, "history.bin"), Buffer.from([0, 1]));
      runGit(root, "add", "history.bin");
      runGit(root, "commit", "-m", "Initial binary");
      fs.writeFileSync(path.join(root, "history.bin"), Buffer.from([0, 2]));
      runGit(root, "add", "history.bin");
      runGit(root, "commit", "-m", "Update binary");
      const commit = runGit(root, "rev-parse", "HEAD");

      const result = await new HostedWorkspaceViewerService(
        root
      ).getFileHistoryDiff("history.bin", commit);

      assert.strictEqual(result.payloadKind, DIFF_PAYLOAD_KINDS.BINARY);
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

  // ── diff payloads ─────────────────────────────────────────────────────────

  suite("diff payloads", () => {
    test("returns image bytes as data URIs for a working-tree image diff", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      const oldBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
      const newBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
      fs.writeFileSync(path.join(root, "image.png"), oldBytes);
      runGit(root, "add", "image.png");
      runGit(root, "commit", "-m", "Add image");
      fs.writeFileSync(path.join(root, "image.png"), newBytes);

      const result = await new HostedWorkspaceViewerService(root).getDiff(
        "image.png"
      );

      assert.strictEqual(result.payloadKind, DIFF_PAYLOAD_KINDS.IMAGE);
      if (result.payloadKind !== DIFF_PAYLOAD_KINDS.IMAGE) return;
      assert.strictEqual(
        result.image.oldImageDataUri,
        `data:image/png;base64,${oldBytes.toString("base64")}`
      );
      assert.strictEqual(
        result.image.newImageDataUri,
        `data:image/png;base64,${newBytes.toString("base64")}`
      );
    });

    test("returns a binary payload instead of decoding binary bytes as text", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      fs.writeFileSync(path.join(root, "data.bin"), Buffer.from([0, 1]));
      runGit(root, "add", "data.bin");
      runGit(root, "commit", "-m", "Add binary");
      fs.writeFileSync(path.join(root, "data.bin"), Buffer.from([0, 2]));

      const result = await new HostedWorkspaceViewerService(root).getDiff(
        "data.bin"
      );

      assert.strictEqual(result.payloadKind, DIFF_PAYLOAD_KINDS.BINARY);
    });

    test("returns image and non-image binary entries for a commit diff", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "baseline.txt", "baseline\n", "Baseline");
      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xaa]);
      fs.writeFileSync(path.join(root, "image.png"), imageBytes);
      fs.writeFileSync(path.join(root, "data.bin"), Buffer.from([0, 3]));
      runGit(root, "add", "image.png", "data.bin");
      runGit(root, "commit", "-m", "Add binary files");
      const commit = runGit(root, "rev-parse", "HEAD");

      const result = await new HostedWorkspaceViewerService(root).getGitRefDiff(
        commit
      );
      const entries = result.nonTextEntries ?? [];
      const imageEntry = entries.find((entry) => entry.path === "image.png");
      const binaryEntry = entries.find((entry) => entry.path === "data.bin");

      assert.ok(imageEntry);
      assert.strictEqual(imageEntry?.payloadKind, DIFF_PAYLOAD_KINDS.IMAGE);
      assert.strictEqual(
        imageEntry?.image?.newImageDataUri,
        `data:image/png;base64,${imageBytes.toString("base64")}`
      );
      assert.ok(binaryEntry);
      assert.strictEqual(binaryEntry?.payloadKind, DIFF_PAYLOAD_KINDS.BINARY);
    });
  });

  // ── getCommitLog ──────────────────────────────────────────────────────────

  suite("getCommitLog", () => {
    test("freezes the complete history for subsequent pages", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "a.txt", "one\n", "First commit");
      commitFile(root, "b.txt", "two\n", "Second commit");
      commitFile(root, "c.txt", "three\n", "Third commit");

      const svc = new HostedWorkspaceViewerService(root);
      const first = await svc.getCommitLog(0, 2);
      assert.strictEqual(first.historyId.length > 0, true);
      assert.strictEqual(first.pageSize, 2);
      assert.strictEqual(first.totalEntries, 3);
      assert.strictEqual(first.offset, 0);
      assert.deepStrictEqual(
        first.commits.map((commit) => commit.subject),
        ["Third commit", "Second commit"]
      );

      commitFile(root, "d.txt", "four\n", "Commit after opening history");
      const continuation = await svc.getCommitLog(
        2,
        2,
        undefined,
        undefined,
        first.historyId
      );

      assert.strictEqual(continuation.totalEntries, 3);
      assert.strictEqual(continuation.offset, 2);
      assert.deepStrictEqual(
        continuation.commits.map((commit) => commit.subject),
        ["First commit"]
      );
      assert.strictEqual(continuation.hasMore, false);

      const refreshed = await svc.getCommitLog(0, 2);
      assert.strictEqual(refreshed.totalEntries, 4);
      assert.notStrictEqual(refreshed.historyId, first.historyId);
    });

    test("rejects invalid, expired, and mismatched history ids", async () => {
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "a.txt", "one\n", "Only commit");
      runGit(root, "branch", "other");

      const svc = new HostedWorkspaceViewerService(root);
      const page = await svc.getCommitLog(0, 1, "other");

      await assert.rejects(
        svc.getCommitLog(0, 1, undefined, undefined, "not-an-id"),
        (error: unknown) => error instanceof WorkspaceTreeBadRequestError
      );
      await assert.rejects(
        svc.getCommitLog(
          0,
          1,
          undefined,
          undefined,
          "00000000-0000-4000-8000-000000000099"
        ),
        (error: unknown) => error instanceof WorkspaceTreeExpiredError
      );
      await assert.rejects(
        svc.getCommitLog(0, 1, undefined, undefined, page.historyId),
        (error: unknown) => error instanceof WorkspaceTreeBadRequestError
      );

      const originalNow = Date.now;
      try {
        Date.now = () => originalNow() + 5 * 60 * 1000;
        await assert.rejects(
          svc.getCommitLog(0, 1, "other", undefined, page.historyId),
          (error: unknown) => error instanceof WorkspaceTreeExpiredError
        );
      } finally {
        Date.now = originalNow;
      }
    });

    test("evicts the oldest snapshots at the count cap", async function () {
      // 33 real branch creations plus 33 getCommitLog calls, each spawning
      // several git subprocesses, comfortably exceeds the file's default
      // 10s budget on a loaded machine.
      this.timeout(30_000);
      const root = createWorkspace();
      runGit(root, "init");
      configureGitIdentity(root);
      commitFile(root, "a.txt", "one\n", "Only commit");
      for (let index = 0; index < 33; index++) {
        runGit(root, "branch", `snapshot-${index}`);
      }

      const svc = new HostedWorkspaceViewerService(root);
      const first = await svc.getCommitLog(0, 1, "snapshot-0");
      let latest = first;
      for (let index = 1; index < 33; index++) {
        latest = await svc.getCommitLog(0, 1, `snapshot-${index}`);
      }

      await assert.rejects(
        svc.getCommitLog(0, 1, "snapshot-0", undefined, first.historyId),
        (error: unknown) => error instanceof WorkspaceTreeExpiredError
      );
      const retained = await svc.getCommitLog(
        0,
        1,
        "snapshot-32",
        undefined,
        latest.historyId
      );
      assert.strictEqual(retained.historyId, latest.historyId);
    });

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
      const featureHash = runGit(root, "rev-parse", "HEAD");

      runGit(root, "checkout", main);
      commitFile(root, "main.txt", "main\n", "main work");
      const mainHash = runGit(root, "rev-parse", "HEAD");
      runGit(root, "merge", "--no-ff", "-m", "merge feature", "feature");

      const svc = new HostedWorkspaceViewerService(root);
      const result = await svc.getCommitLog();

      const merge = result.commits.find((c) => c.subject === "merge feature");
      assert.ok(merge, "merge commit should be present");
      assert.strictEqual(merge?.isMerge, true);
      assert.deepStrictEqual(merge?.parentHashes, [mainHash, featureHash]);
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

      const result = await svc.listDirectory({
        path: "",
        includeGitIgnored: true,
      });

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

      const result = await svc.listDirectory({
        path: "secondary",
        includeGitIgnored: true,
      });

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
        const result = await svc.listDirectory({
          path: "",
          includeGitIgnored: true,
        });
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
