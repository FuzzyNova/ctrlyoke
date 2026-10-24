import * as assert from "assert";
import { suite, test } from "mocha";
import {
  WorkspaceSearchSession,
  WorkspaceSearchSessionStore,
  type WorkspaceSearchCandidate,
  type WorkspaceSearchFileScanner,
  type WorkspaceSearchParams,
} from "../../server/WorkspaceSearchSession";
import { WORKSPACE_ENTRY_KINDS } from "../../types/DashboardConstants";

const PARAMS: WorkspaceSearchParams = {
  query: "needle",
  scope: "content",
  includeGitIgnored: false,
  repo: undefined,
};

function candidate(name: string): WorkspaceSearchCandidate {
  return { absolutePath: `/root/${name}`, viewerPath: name };
}

async function* batches(
  ...groups: WorkspaceSearchCandidate[][]
): AsyncGenerator<WorkspaceSearchCandidate[]> {
  for (const group of groups) yield group;
}

/** Every file holds `matchesPerFile` matching lines. */
function scanner(matchesPerFile: number): WorkspaceSearchFileScanner {
  return async (file, _query, maxMatches) =>
    Array.from({ length: Math.min(matchesPerFile, maxMatches) }, (_, i) => ({
      kind: WORKSPACE_ENTRY_KINDS.CONTENT,
      path: file.viewerPath,
      line: i + 1,
      matchSnippet: "needle",
    }));
}

const UNLIMITED = {
  deadline: Number.POSITIVE_INFINITY,
  maxFiles: Number.POSITIVE_INFINITY,
  lookaheadMs: 60_000,
  partialPageMs: 60_000,
};

suite("WorkspaceSearchSession", () => {
  test("stops at the result cap and reports the count as a lower bound", async () => {
    const session = new WorkspaceSearchSession(
      PARAMS,
      batches([candidate("a.txt"), candidate("b.txt")]),
      scanner(3),
      4
    );

    const page = await session.page(0, 2, UNLIMITED);

    assert.strictEqual(page.totalCount, 4);
    assert.strictEqual(page.complete, true);
    assert.strictEqual(page.capped, true);
  });

  test("is exact, not capped, when the scan ends at the cap", async () => {
    const session = new WorkspaceSearchSession(
      PARAMS,
      batches([candidate("a.txt"), candidate("b.txt")]),
      scanner(2),
      4
    );

    const page = await session.page(0, 10, UNLIMITED);

    assert.strictEqual(page.totalCount, 4);
    assert.strictEqual(page.complete, true);
    assert.strictEqual(page.capped, false);
  });

  test("shares one file budget between the page and its lookahead", async () => {
    const session = new WorkspaceSearchSession(
      PARAMS,
      batches(
        [candidate("a.txt"), candidate("b.txt")],
        [candidate("c.txt"), candidate("d.txt")]
      ),
      scanner(1),
      100
    );

    const first = await session.page(0, 1, { ...UNLIMITED, maxFiles: 3 });
    const rest = await session.page(1, 10, UNLIMITED);

    assert.deepStrictEqual(
      first.results.map((match) => match.path),
      ["a.txt"]
    );
    assert.strictEqual(first.totalCount, 3);
    assert.strictEqual(first.complete, false);
    assert.deepStrictEqual(
      rest.results.map((match) => match.path),
      ["b.txt", "c.txt", "d.txt"]
    );
    assert.strictEqual(rest.complete, true);
  });

  test("answers a partial page once it has a result and its partial time has passed", async () => {
    // Files are scanned in batches of 8, so the page stops after the first.
    const names = Array.from({ length: 9 }, (_, i) => `file-${i}.txt`);
    const session = new WorkspaceSearchSession(
      PARAMS,
      batches(names.map(candidate)),
      scanner(1),
      100
    );

    const page = await session.page(0, 50, {
      ...UNLIMITED,
      partialPageMs: 0,
      lookaheadMs: 0,
    });

    assert.deepStrictEqual(
      page.results.map((match) => match.path),
      names.slice(0, 8)
    );
    assert.strictEqual(page.complete, false);
  });

  test("reports a name match instead of scanning the file's content", async () => {
    let scanned = 0;
    const session = new WorkspaceSearchSession(
      { ...PARAMS, scope: "both" },
      batches([candidate("needle.txt"), candidate("other.txt")]),
      async (file, query, maxMatches) => {
        scanned++;
        return scanner(1)(file, query, maxMatches);
      },
      100
    );

    const page = await session.page(0, 10, UNLIMITED);

    assert.deepStrictEqual(
      page.results.map((match) => [match.kind, match.path]),
      [
        [WORKSPACE_ENTRY_KINDS.FILE, "needle.txt"],
        [WORKSPACE_ENTRY_KINDS.CONTENT, "other.txt"],
      ]
    );
    assert.strictEqual(scanned, 1);
  });
});

suite("WorkspaceSearchSessionStore", () => {
  function session(params = PARAMS): WorkspaceSearchSession {
    return new WorkspaceSearchSession(params, batches(), scanner(0), 10);
  }

  test("finds a session only with the parameters it was started with", () => {
    const store = new WorkspaceSearchSessionStore(4, 60_000);
    const live = session();
    store.add(live);

    assert.strictEqual(store.find(live.id, PARAMS), live);
    assert.strictEqual(
      store.find(live.id, { ...PARAMS, includeGitIgnored: true }),
      undefined
    );
    assert.strictEqual(store.find(undefined, PARAMS), undefined);
  });

  test("evicts the least recently used session when full", () => {
    const store = new WorkspaceSearchSessionStore(2, 60_000);
    const first = session();
    const second = session();
    store.add(first);
    store.add(second);
    store.find(first.id, PARAMS);
    store.add(session());

    assert.strictEqual(store.find(first.id, PARAMS), first);
    assert.strictEqual(store.find(second.id, PARAMS), undefined);
  });

  test("expires an idle session", () => {
    const store = new WorkspaceSearchSessionStore(4, 1_000);
    const idle = session();
    store.add(idle);
    idle.lastUsedAt -= 2_000;

    assert.strictEqual(store.find(idle.id, PARAMS), undefined);
  });
});
