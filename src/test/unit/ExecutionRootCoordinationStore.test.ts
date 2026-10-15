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
  trimmingPreservesUnresolvedClaims,
} from "../../core/orchestration/ExecutionRootCoordinationStore";
import type { CoordinationEntry } from "../../types/CtrlYokeTypes";
import {
  resolveExecutionRootScope,
  scopeStorageRoot,
  sweepOrphanedScopeStorage,
} from "../../core/orchestration/ExecutionRootScope";
import { ExecutionRootLeaseManager } from "../../core/orchestration/ExecutionRootLeaseManager";

const execFileAsync = promisify(execFile);

suite("ExecutionRootCoordinationStore", function () {
  this.timeout(30_000);

  function withPlatform<T>(platform: NodeJS.Platform, action: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      ...descriptor,
      value: platform,
    });
    try {
      return action();
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  }

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
        kind: "external" as const,
        attested: false,
      },
      text,
      via: "cli" as const,
    };
  }

  function claim(
    participantId: string,
    claimPath: string,
    seq: number
  ): CoordinationEntry {
    return {
      seq,
      at: new Date(seq).toISOString(),
      kind: "claim",
      from: {
        participantId,
        label: participantId,
        kind: "external" as const,
        attested: false,
      },
      paths: [claimPath],
      via: "cli",
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

  test("sweeps scope storage only for worktrees that no longer exist", async () => {
    const parent = await tempDirectory("sweep");
    const source = path.join(parent, "source");
    const removed = path.join(parent, "removed");
    const kept = path.join(parent, "kept");
    await fs.mkdir(source);
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", source, ...args], { stdio: "ignore" });
      execFileSync("git", ["init", source], { stdio: "ignore" });
      git("config", "user.name", "Tests");
      git("config", "user.email", "tests@example.com");
      await fs.writeFile(path.join(source, "tracked.txt"), "base\n", "utf8");
      git("add", "tracked.txt");
      git("commit", "-m", "initial");
      git("worktree", "add", "-b", "sweep-removed", removed);
      git("worktree", "add", "-b", "sweep-kept", kept);

      for (const root of [source, removed, kept]) {
        await new ExecutionRootCoordinationStore(root).append(
          note("writer", root)
        );
      }
      const removedScope = await resolveCoordinationBoardScope(removed);
      const keptScope = await resolveCoordinationBoardScope(kept);
      const sourceScope = await resolveCoordinationBoardScope(source);

      assert.deepStrictEqual(await sweepOrphanedScopeStorage(source), []);
      git("worktree", "remove", removed);

      assert.deepStrictEqual(await sweepOrphanedScopeStorage(kept), [
        removedScope.storageRoot,
      ]);
      await assert.rejects(fs.access(removedScope.storageRoot));
      await fs.access(keptScope.boardPath);
      await fs.access(sourceScope.boardPath);
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
          .append({ kind: "note", from: { participantId: process.argv[3], label: process.argv[3], kind: "external", attested: false }, via: "cli", text: "child" })
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

  test("names and enforces the invariant that unresolved claims are not droppable", async () => {
    const root = await tempDirectory("unresolved-claim");
    try {
      const store = new ExecutionRootCoordinationStore(root, {
        retention: { maxEntries: 2 },
      });
      await store.append(claim("holder", "src/held.ts", 1));
      await store.append(note("chatty", "one"));
      await store.append(note("chatty", "two"));

      const result = await store.read({ limit: 10 });
      assert.ok(
        result.entries.some(
          (entry) =>
            entry.kind === "claim" && entry.paths?.includes("src/held.ts")
        )
      );
      assert.strictEqual(
        trimmingPreservesUnresolvedClaims(
          result.entries,
          result.entries.filter((entry) => entry.kind !== "note")
        ),
        true
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("resolves differently-cased releases on Windows during retention checks", () => {
    withPlatform("win32", () => {
      const settledEntries: CoordinationEntry[] = [
        claim("holder", "Coordination-Probe/R2/DIR", 1),
        {
          seq: 2,
          at: new Date(2).toISOString(),
          kind: "release",
          from: {
            participantId: "holder",
            label: "holder",
            kind: "external",
            attested: false,
          },
          paths: ["COORDINATION-probe/r2/dir/"],
          via: "cli",
        },
      ];
      assert.strictEqual(
        trimmingPreservesUnresolvedClaims(settledEntries, []),
        true
      );
    });
  });

  test("evicts notes from the largest contributor and preserves a quiet participant", async () => {
    const root = await tempDirectory("largest-contributor");
    try {
      const store = new ExecutionRootCoordinationStore(root, {
        retention: { maxEntries: 3 },
      });
      await store.append(note("chatty", "chatty-1"));
      await store.append(note("quiet", "quiet-note"));
      await store.append(note("chatty", "chatty-2"));
      await store.append(note("chatty", "chatty-3"));

      const result = await store.read({ limit: 10 });
      assert.ok(
        result.entries.some((entry) => entry.from.participantId === "quiet")
      );
      assert.strictEqual(result.entries.length, 3);
      assert.ok(
        result.entries.filter((entry) => entry.from.participantId === "chatty")
          .length < 3
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("fails an over-cap append clearly while reads still succeed", async () => {
    const root = await tempDirectory("over-cap");
    try {
      const store = new ExecutionRootCoordinationStore(root, {
        retention: { maxEntries: 1 },
      });
      await store.append(claim("holder", "src/held.ts", 1));

      await assert.rejects(
        store.append(claim("other", "src/other.ts", 2)),
        /capacity exceeded: unresolved claims fill the board/
      );
      const result = await store.read({ limit: 10 });
      assert.strictEqual(result.entries.length, 1);
      assert.deepStrictEqual(result.entries[0].paths, ["src/held.ts"]);
    } finally {
      await removeDirectory(root);
    }
  });

  test("trims notes by age during the next append", async () => {
    const root = await tempDirectory("age");
    const now = Date.parse("2026-09-11T12:00:00.000Z");
    try {
      const store = new ExecutionRootCoordinationStore(root, {
        now: () => now,
        retention: { maxNoteAgeHours: 7 * 24 },
      });
      await store.append({
        ...note("old", "expired"),
        at: "2026-09-01T12:00:00.000Z",
      });
      await store.append({
        ...note("new", "retained"),
        at: "2026-09-11T12:00:00.000Z",
      });

      const result = await store.read({ limit: 10 });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.text),
        ["retained"]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("hides an expired note from reads before any append compacts it", async () => {
    const root = await tempDirectory("age-read");
    let now = Date.parse("2026-09-11T12:00:00.000Z");
    try {
      const store = new ExecutionRootCoordinationStore(root, {
        now: () => now,
        retention: { maxNoteAgeHours: 24 },
      });
      await store.append({
        ...note("writer", "fresh then stale"),
        at: "2026-09-11T12:00:00.000Z",
      });
      assert.strictEqual((await store.read()).entries.length, 1);

      now = Date.parse("2026-09-12T13:00:00.000Z");
      assert.deepStrictEqual((await store.read()).entries, []);
    } finally {
      await removeDirectory(root);
    }
  });

  test("keeps an old note visible and retained while its author is live", async () => {
    const root = await tempDirectory("age-live");
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    try {
      const store = new ExecutionRootCoordinationStore(root, {
        now: () => now,
        retention: { maxNoteAgeHours: 24 },
        liveParticipants: () => new Set(["running"]),
      });
      await store.append({
        ...note("running", "plan from a live sibling"),
        at: "2026-09-01T12:00:00.000Z",
      });
      await store.append({
        ...note("finished", "plan from a departed agent"),
        at: "2026-09-01T12:00:00.000Z",
      });
      await store.append(note("writer", "trigger retention"));

      assert.deepStrictEqual(
        (await store.read()).entries.map((entry) => entry.text),
        ["plan from a live sibling", "trigger retention"]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("leaves out the reader's own entries and counts what a latest page omits", async () => {
    const root = await tempDirectory("select");
    try {
      const store = new ExecutionRootCoordinationStore(root);
      await store.append(note("me", "mine"));
      for (const text of ["one", "two", "three"]) {
        await store.append(note("other", text));
      }

      const result = await store.read({
        excludeFrom: "me",
        latest: true,
        limit: 2,
      });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.text),
        ["two", "three"]
      );
      assert.strictEqual(result.omittedOlder, 1);
      assert.strictEqual(result.nextCursor, undefined);
    } finally {
      await removeDirectory(root);
    }
  });

  test("folds settled claim and release pairs out of the board", async () => {
    const root = await tempDirectory("settled-pair");
    try {
      const store = new ExecutionRootCoordinationStore(root);
      await store.append(claim("holder", "src/settled.ts", 1));
      await store.append({
        kind: "release",
        from: {
          participantId: "holder",
          label: "holder",
          kind: "external" as const,
          attested: false,
        },
        paths: ["src/settled.ts"],
        via: "cli",
      });
      await store.append(note("reader", "still readable"));

      const result = await store.read({ limit: 10 });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.kind),
        ["note"]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  function lifecycle(participantId: string, kind: "join" | "leave") {
    return {
      kind,
      from: {
        participantId,
        label: participantId,
        kind: "external" as const,
        attested: false,
      },
      via: "cli" as const,
    };
  }

  test("folds a departed participant's join and leave pair out of the board", async () => {
    const root = await tempDirectory("settled-lifecycle");
    try {
      const store = new ExecutionRootCoordinationStore(root);
      await store.append(lifecycle("gone", "join"));
      // The registry re-emits `join` to refresh a lease, so one participant
      // routinely has several open joins; every one must settle on leave.
      await store.append(lifecycle("gone", "join"));
      await store.append(lifecycle("gone", "leave"));
      await store.append(lifecycle("here", "join"));
      await store.append(note("gone", "attribution survives the lease"));

      const result = await store.read({ limit: 10 });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.kind),
        ["join", "note"],
        "only the live participant's join should remain"
      );
      // `from` is denormalised, so the departed author is still attributable.
      assert.strictEqual(result.entries[1].from.participantId, "gone");
    } finally {
      await removeDirectory(root);
    }
  });

  test("keeps a departed participant's lifecycle entries while it still holds a claim", async () => {
    const root = await tempDirectory("claim-holding-lifecycle");
    try {
      const store = new ExecutionRootCoordinationStore(root);
      await store.append(lifecycle("holder", "join"));
      await store.append(claim("holder", "src/held.ts", 2));
      await store.append(lifecycle("holder", "join"));
      await store.append(lifecycle("holder", "join"));
      await store.append(note("other", "unrelated"));

      const result = await store.read({ limit: 10 });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.kind),
        ["join", "claim", "join", "note"]
      );
      assert.deepStrictEqual(
        result.entries
          .filter((entry) => entry.kind === "join")
          .map((entry) => entry.seq),
        [1, 4],
        "the lifecycle start and latest lease join should remain"
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("ages out only claim-free lifecycles whose latest join is old", async () => {
    const root = await tempDirectory("lifecycle-age");
    let now = Date.parse("2026-09-01T12:00:00.000Z");
    const store = new ExecutionRootCoordinationStore(root, {
      now: () => now,
      retention: { maxNoteAgeHours: 7 * 24 },
    });
    const at = (date: string) => ({ at: date });
    try {
      await store.append({
        ...lifecycle("dead", "join"),
        ...at("2026-09-01T12:00:00.000Z"),
      });
      await store.append({
        ...lifecycle("dead", "join"),
        ...at("2026-09-05T12:00:00.000Z"),
      });
      await store.append({
        ...lifecycle("claimed", "join"),
        ...at("2026-09-01T12:00:00.000Z"),
      });
      await store.append({
        ...claim("claimed", "src/held.ts", 4),
        at: "2026-09-01T12:00:00.000Z",
      });
      await store.append({
        ...lifecycle("refreshed", "join"),
        ...at("2026-09-01T12:00:00.000Z"),
      });
      await store.append({
        ...lifecycle("refreshed", "join"),
        ...at("2026-09-19T12:00:00.000Z"),
      });

      now = Date.parse("2026-09-20T12:00:00.000Z");
      await store.append(note("writer", "trigger retention"));

      const entries = (await store.read({ limit: 20 })).entries;
      assert.deepStrictEqual(
        entries.map((entry) => `${entry.kind}:${entry.from.participantId}`),
        [
          "join:claimed",
          "claim:claimed",
          "join:refreshed",
          "join:refreshed",
          "note:writer",
        ]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("reports lifecycle capacity separately when no unresolved claim remains", async () => {
    const root = await tempDirectory("lifecycle-over-cap");
    try {
      const store = new ExecutionRootCoordinationStore(root, {
        retention: { maxEntries: 1 },
      });
      await store.append(lifecycle("live", "join"));

      await assert.rejects(
        store.append(lifecycle("other", "join")),
        /capacity exceeded: only non-evictable participant lifecycle entries remain/
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("does not wedge the board once lifecycle entries alone reach the cap", async () => {
    const root = await tempDirectory("lifecycle-cap");
    try {
      const store = new ExecutionRootCoordinationStore(root, {
        retention: { maxEntries: 6 },
      });
      // Without lifecycle folding these accumulate forever, and the first
      // append past the cap fails permanently with no removable note.
      for (let index = 0; index < 20; index += 1) {
        await store.append(lifecycle(`participant-${index}`, "join"));
        await store.append(lifecycle(`participant-${index}`, "leave"));
      }
      await store.append(note("late", "still writable"));

      const result = await store.read({ limit: 10 });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.text),
        ["still writable"]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("uses the configured page size even when a read omits its limit", async () => {
    const root = await tempDirectory("configured-page");
    try {
      const store = new ExecutionRootCoordinationStore(root, {
        retention: { readNotesPageSize: 2 },
      });
      await store.append(note("one", "one"));
      await store.append(note("two", "two"));
      await store.append(note("three", "three"));

      const result = await store.read();
      assert.strictEqual(result.entries.length, 2);
      assert.strictEqual(result.nextCursor, 2);
    } finally {
      await removeDirectory(root);
    }
  });

  test("recovers from a truncated final line on read and append", async () => {
    const root = await tempDirectory("truncated-tail");
    try {
      const store = new ExecutionRootCoordinationStore(root);
      await store.append(note("writer", "kept"));
      const { boardPath } = await store.getScopeInfo();
      await fs.appendFile(boardPath, '{"seq":2,"kind":"note"');

      assert.deepStrictEqual(
        (await store.read()).entries.map((entry) => entry.text),
        ["kept"]
      );
      await store.append(note("writer", "recovered"));
      assert.deepStrictEqual(
        (await store.read()).entries.map((entry) => entry.text),
        ["kept", "recovered"]
      );
    } finally {
      await removeDirectory(root);
    }
  });

  test("moves a board with a corrupt middle line aside and starts fresh", async () => {
    const root = await tempDirectory("corrupt-middle");
    try {
      const store = new ExecutionRootCoordinationStore(root);
      await store.append(note("writer", "before"));
      const { boardPath } = await store.getScopeInfo();
      const valid = await fs.readFile(boardPath, "utf8");
      await fs.writeFile(boardPath, `${valid}not-json\n${valid}`, "utf8");

      assert.deepStrictEqual((await store.read()).entries, []);
      assert.strictEqual(
        (await fs.readdir(path.dirname(boardPath))).filter((name) =>
          name.startsWith("board.jsonl.corrupt-")
        ).length,
        1
      );
      await store.append(note("writer", "fresh"));
      assert.deepStrictEqual(
        (await store.read()).entries.map((entry) => entry.text),
        ["fresh"]
      );
    } finally {
      await removeDirectory(root);
    }
  });
});
