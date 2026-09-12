import * as assert from "assert";
import { execFile, execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { suite, test } from "mocha";
import {
  ExecutionRootCoordinationStore,
  resolveCoordinationBoardScope,
} from "../../core/orchestration/ExecutionRootCoordinationStore";
import {
  resolveExecutionRootScope,
  scopeStorageRoot,
} from "../../core/orchestration/ExecutionRootScope";
import { ExecutionRootLeaseManager } from "../../core/orchestration/ExecutionRootLeaseManager";

const execFileAsync = promisify(execFile);

suite("ExecutionRootCoordinationStore", function () {
  this.timeout(30_000);

  async function tempDirectory(name: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `ctrlyoke-coordination-${name}-`));
  }

  async function removeDirectory(directory: string): Promise<void> {
    await fs.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }

  function note(participantId: string, text: string) {
    return {
      kind: "note" as const,
      from: {
        participantId,
        label: participantId,
        attested: false,
      },
      text,
      via: "cli" as const,
    };
  }

  test("uses the same scope identity as the execution lease manager", async () => {
    const root = await tempDirectory("identity");
    try {
      const shared = await resolveExecutionRootScope(root);
      const lease = await ExecutionRootLeaseManager.getScopeInfo(root);
      const board = await resolveCoordinationBoardScope(root);

      assert.strictEqual(shared.identity, lease.identity);
      assert.strictEqual(shared.identity, board.identity);
      assert.strictEqual(
        board.storageRoot,
        path.join(root, ".ctrlyoke", "coordination")
      );
      assert.strictEqual(
        board.boardPath,
        path.join(root, ".ctrlyoke", "coordination", "board.jsonl")
      );
      assert.strictEqual(
        scopeStorageRoot(shared, "execution-leases"),
        lease.storageRoot
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("uses worktree-specific identity with common Git storage", async () => {
    const parent = await tempDirectory("git-shapes");
    const source = path.join(parent, "source");
    const worktree = path.join(parent, "worktree");
    await fs.mkdir(source);
    try {
      execFileSync("git", ["init", source], { stdio: "ignore" });
      execFileSync("git", ["-C", source, "config", "user.name", "Tests"], {
        stdio: "ignore",
      });
      execFileSync(
        "git",
        ["-C", source, "config", "user.email", "tests@example.com"],
        { stdio: "ignore" }
      );
      await fs.writeFile(path.join(source, "tracked.txt"), "base\n", "utf8");
      execFileSync("git", ["-C", source, "add", "tracked.txt"]);
      execFileSync("git", ["-C", source, "commit", "-m", "initial"]);
      execFileSync("git", [
        "-C",
        source,
        "worktree",
        "add",
        "-b",
        "coordination-test",
        worktree,
      ]);

      const sourceScope = await resolveCoordinationBoardScope(source);
      const worktreeScope = await resolveCoordinationBoardScope(worktree);
      const worktreeLease =
        await ExecutionRootLeaseManager.getScopeInfo(worktree);

      assert.notStrictEqual(sourceScope.identity, worktreeScope.identity);
      assert.strictEqual(
        sourceScope.storageRoot,
        path.join(
          source,
          ".git",
          "ctrlyoke",
          "coordination",
          sourceScope.scopeHash
        )
      );
      assert.strictEqual(
        worktreeScope.storageRoot,
        path.join(
          source,
          ".git",
          "ctrlyoke",
          "coordination",
          worktreeScope.scopeHash
        )
      );
      assert.strictEqual(worktreeScope.identity, worktreeLease.identity);
      assert.ok(!worktreeScope.boardPath.startsWith(worktree));
    } finally {
      await removeDirectory(parent);
    }
  });

  test("assigns gapless sequences across separate node processes", async () => {
    const root = await tempDirectory("processes");
    try {
      const modulePath = path.resolve(
        __dirname,
        "../../core/orchestration/ExecutionRootCoordinationStore"
      );
      const childCode = `
        const { ExecutionRootCoordinationStore } = require(process.argv[1]);
        new ExecutionRootCoordinationStore(process.argv[2])
          .append({ kind: "note", from: { participantId: process.argv[3], label: process.argv[3], attested: false }, via: "cli", text: "child" })
          .catch((error) => { console.error(error); process.exitCode = 1; });
      `;
      const count = 12;
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          execFileAsync(process.execPath, [
            "-e",
            childCode,
            modulePath,
            root,
            `participant-${index}`,
          ])
        )
      );

      const result = await new ExecutionRootCoordinationStore(root).read({
        limit: count,
      });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.seq),
        Array.from({ length: count }, (_, index) => index + 1)
      );
      assert.strictEqual(result.nextCursor, undefined);
    } finally {
      await removeDirectory(root);
    }
  });

  test("pages by sequence and participant without assuming contiguous data", async () => {
    const root = await tempDirectory("paging");
    try {
      const store = new ExecutionRootCoordinationStore(root);
      await store.append(note("one", "one-a"));
      await store.append(note("two", "two-a"));
      await store.append(note("one", "one-b"));
      await store.append(note("two", "two-b"));
      await store.append(note("one", "one-c"));

      const first = await store.read({ limit: 2 });
      assert.deepStrictEqual(
        first.entries.map((entry) => entry.seq),
        [1, 2]
      );
      assert.strictEqual(first.nextCursor, 2);

      const second = await store.read({ since: first.nextCursor, limit: 2 });
      assert.deepStrictEqual(
        second.entries.map((entry) => entry.seq),
        [3, 4]
      );
      assert.strictEqual(second.nextCursor, 4);

      const fromOne = await store.read({ since: 0, from: ["one"] });
      assert.deepStrictEqual(
        fromOne.entries.map((entry) => entry.text),
        ["one-a", "one-b", "one-c"]
      );

      const scope = await store.getScopeInfo();
      const lines = (await fs.readFile(scope.boardPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { seq: number });
      lines[1].seq = 9;
      await fs.writeFile(
        scope.boardPath,
        `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
        "utf8"
      );

      const gap = await store.read({ since: 1 });
      assert.deepStrictEqual(
        gap.entries.map((entry) => entry.seq),
        [9, 3, 4, 5]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("refuses a board whose scope record belongs to another root", async () => {
    const root = await tempDirectory("scope-record");
    try {
      const store = new ExecutionRootCoordinationStore(root);
      await store.append(note("one", "initial"));
      const scope = await store.getScopeInfo();
      await fs.writeFile(
        scope.scopeRecordPath,
        JSON.stringify({ scopeIdentity: "different-scope" }),
        "utf8"
      );

      await assert.rejects(
        store.append(note("one", "should fail")),
        /Coordination scope mismatch.*refusing to use it/
      );
      await assert.rejects(
        store.read(),
        /Coordination scope mismatch.*refusing to use it/
      );
    } finally {
      await removeDirectory(root);
    }
  });
});
