import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import {
  createHistorySearchLinePrefilter,
  listDocumentShardEntries,
  resolveShardVisitOrder,
  streamHistorySearchDocuments,
} from "../../core/orchestration/HistorySearchShardScanner";
import { getDocumentsShardFileName } from "../../core/orchestration/historySearchRebuildWorker";
import type { HistorySearchIndexManifest } from "../../core/orchestration/historySearchRebuildWorker";
import {
  HISTORY_EVENT_KINDS,
  HISTORY_MATCH_FIELDS,
} from "../../types/DashboardConstants";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import { FINAL_STEP_PHASES } from "../../types/DashboardConstants";
import type { HistorySearchDocument } from "../../types/WorkflowTimelineTypes";
import {
  createHistorySearchMatcher,
  disposeHistorySearchMatcher,
} from "../../core/orchestration/HistorySearchMatcher";

suite("HistorySearchShardScanner", () => {
  const INDEXED_KEY_OPTIONS = { hasPersistedLowercaseKey: true };
  const LEGACY_SHARD_OPTIONS = { hasPersistedLowercaseKey: false };
  let documentsDirectory: string;

  setup(async () => {
    documentsDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "history-search-shard-scanner-")
    );
  });

  teardown(async () => {
    await fs.rm(documentsDirectory, { recursive: true, force: true });
  });

  test("finds a document containing a double quote", async () => {
    const query = 'quoted "term"';
    await writeShard("quotes.jsonl", [createDocument(query)]);

    assert.deepStrictEqual(await matchingTexts(query), [query]);
  });

  test("finds a document containing a backslash", async () => {
    const query = String.raw`path\\with\\slashes`;
    await writeShard("backslashes.jsonl", [createDocument(query)]);

    assert.deepStrictEqual(await matchingTexts(query), [query]);
  });

  test("finds a document containing a newline", async () => {
    const query = "first line\nsecond line";
    await writeShard("newlines.jsonl", [createDocument(query)]);

    assert.deepStrictEqual(await matchingTexts(query), [query]);
  });

  test("finds a document containing a tab", async () => {
    const query = "first\tsecond";
    await writeShard("tabs.jsonl", [createDocument(query)]);

    assert.deepStrictEqual(await matchingTexts(query), [query]);
  });

  test("matches ASCII case differences", async () => {
    await writeShard("case.jsonl", [createDocument("A Mixed Case Needle")]);

    assert.deepStrictEqual(await matchingTexts("mixed case needle"), [
      "A Mixed Case Needle",
    ]);
  });

  test("uses the serialized lowercased text key for ASCII queries", () => {
    const document = createDocument("A Mixed Case Needle");
    const line = JSON.stringify(document);

    assert.strictEqual(line.includes('"text":"mixed case needle"'), false);
    assert.strictEqual(
      createHistorySearchLinePrefilter(
        "mixed case needle",
        INDEXED_KEY_OPTIONS
      )(line),
      true
    );
  });

  test("keeps regex prefiltering permissive when no literal is provable", () => {
    const matcher = createHistorySearchMatcher("[A-Z].+\\d+", true);
    const document = createDocument("ERROR 404");
    assert.strictEqual(
      createHistorySearchLinePrefilter(
        matcher,
        INDEXED_KEY_OPTIONS
      )(JSON.stringify(document)),
      true
    );
    disposeHistorySearchMatcher(matcher);
  });

  test("uses a required regex literal without matching the raw JSON line", () => {
    const matcher = createHistorySearchMatcher('quoted "term"', true);
    const document = createDocument('Quoted "term" here');
    const line = JSON.stringify(document);
    assert.strictEqual(
      createHistorySearchLinePrefilter(matcher, INDEXED_KEY_OPTIONS)(line),
      true
    );
    disposeHistorySearchMatcher(matcher);
  });

  test("keeps quantified regex literals from rejecting matching documents", async () => {
    const cases = [
      { pattern: "xa+y", text: "xaay" },
      { pattern: "ab{1,3}c", text: "abbc" },
      { pattern: "err{2}or", text: "errror" },
      { pattern: "(ab)+c", text: "ababc" },
    ];

    for (const [index, { pattern, text }] of cases.entries()) {
      const matcher = createHistorySearchMatcher(pattern, true);
      const document = createDocument(text);
      const line = JSON.stringify(document);
      assert.ok(matcher.find(text), `${pattern} should match ${text}`);
      assert.strictEqual(
        createHistorySearchLinePrefilter(matcher, INDEXED_KEY_OPTIONS)(line),
        true,
        `prefilter rejected matching text ${JSON.stringify(text)} for ${pattern}`
      );

      const shardName = `quantified-${index}.jsonl`;
      await writeShard(shardName, [document]);
      const scanned: string[] = [];
      for await (const candidate of streamHistorySearchDocuments(
        documentsDirectory,
        matcher,
        { ...INDEXED_KEY_OPTIONS, resolvedShardOrder: [shardName] }
      )) {
        scanned.push(candidate.text);
      }
      assert.deepStrictEqual(scanned, [text]);
      disposeHistorySearchMatcher(matcher);
    }
  });

  test("degrades permissively for a non-ASCII query", async () => {
    const documents = [
      createDocument("A bright Éclair"),
      createDocument("An unrelated document"),
      createDocument("Another ÉCLAIR detail"),
    ];
    await writeShard("unicode.jsonl", documents);

    const query = "éClAiR";
    const actualMatches = documents
      .map((document) => document.text)
      .filter((text) => text.toLowerCase().includes(query.toLowerCase()));
    assert.deepStrictEqual(await matchingTexts(query), actualMatches);
  });

  test("never rejects a keyed line whose parsed text really matches", () => {
    const texts = Array.from(
      { length: 32 },
      (_, index) =>
        `Generated ${index}: Alpha-${index % 4}\\path\nvalue\t${index}`
    );
    const cases = texts.flatMap((text, index) => [
      { text, query: text.slice(index % 8, (index % 8) + 7) },
      { text, query: text.slice(0, 5).toUpperCase() },
    ]);

    for (const { text, query } of cases) {
      const document = createDocument(text);
      const line = JSON.stringify(document);
      const expected = document.text
        .toLowerCase()
        .includes(query.toLowerCase());

      if (expected) {
        assert.strictEqual(
          createHistorySearchLinePrefilter(query, INDEXED_KEY_OPTIONS)(line),
          true,
          `prefilter rejected generated match for query ${JSON.stringify(query)}`
        );
      }
    }

    const regexCases = [
      { pattern: "error (code|mode)", text: "error code" },
      { pattern: "(error.)code", text: "errorXcode" },
      { pattern: "x(ba|ca)", text: "xba" },
      { pattern: "(a.)c", text: "abc" },
      { pattern: "(?=abc)a", text: "abc" },
    ];
    for (const { pattern, text } of regexCases) {
      const matcher = createHistorySearchMatcher(pattern, true);
      const document = createDocument(text);
      const line = JSON.stringify(document);

      assert.ok(matcher.find(text), `${pattern} should match ${text}`);
      assert.strictEqual(
        createHistorySearchLinePrefilter(matcher, INDEXED_KEY_OPTIONS)(line),
        true,
        `prefilter rejected generated regex match ${JSON.stringify(text)} for ${pattern}`
      );
      disposeHistorySearchMatcher(matcher);
    }
  });

  test("finds a mixed-case match in shards written before the lowercase key", async () => {
    // A schema-upgrading rebuild builds into `rebuild-<ts>/` and swaps only at
    // the end, so a search running beside it streams shards that have no
    // `textLower`. Matching the lowercased query against those lines directly
    // would drop every document whose stored text is not already lowercase.
    const legacyDocument = createLegacyDocument("Using CodeMirror here");
    await fs.writeFile(
      path.join(documentsDirectory, "legacy.jsonl"),
      JSON.stringify(legacyDocument) + "\n",
      "utf8"
    );

    assert.deepStrictEqual(
      await matchingTexts("codemirror", LEGACY_SHARD_OPTIONS),
      ["Using CodeMirror here"]
    );
  });

  test("rejects a legacy line only when the lowercase key is assumed present", () => {
    const legacyLine = JSON.stringify(
      createLegacyDocument("Using CodeMirror here")
    );

    assert.strictEqual(
      createHistorySearchLinePrefilter(
        "codemirror",
        LEGACY_SHARD_OPTIONS
      )(legacyLine),
      true
    );
    assert.strictEqual(
      createHistorySearchLinePrefilter(
        "codemirror",
        INDEXED_KEY_OPTIONS
      )(legacyLine),
      false
    );
  });

  test("ignores a shard deleted after listing it but before reading it", async () => {
    const firstShardPath = await writeShard("a-first.jsonl", [
      createDocument("first match"),
    ]);
    const deletedShardPath = await writeShard("b-deleted.jsonl", [
      createDocument("deleted match"),
    ]);

    const results: HistorySearchDocument[] = [];
    for await (const document of streamHistorySearchDocuments(
      documentsDirectory,
      "match",
      INDEXED_KEY_OPTIONS
    )) {
      results.push(document);
      if (document.text === "first match") {
        await fs.rm(deletedShardPath);
      }
    }

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.text, "first match");
    await fs.access(firstShardPath);
  });

  test("stops between shards once the signal is aborted", async () => {
    await writeShard("a-first.jsonl", [createDocument("abort shard match")]);
    await writeShard("b-second.jsonl", [createDocument("abort shard match")]);

    const controller = new AbortController();
    const results: HistorySearchDocument[] = [];
    for await (const document of streamHistorySearchDocuments(
      documentsDirectory,
      "abort shard match",
      INDEXED_KEY_OPTIONS,
      undefined,
      controller.signal
    )) {
      results.push(document);
      // Aborting right after the first shard's only document must stop the
      // scan before it ever opens the second shard.
      controller.abort();
    }

    assert.strictEqual(results.length, 1);
  });

  test("stops between lines within a shard once the signal is aborted", async () => {
    await writeShard("multi-line.jsonl", [
      createDocument("abort line match first"),
      createDocument("abort line match second"),
    ]);

    const controller = new AbortController();
    const results: HistorySearchDocument[] = [];
    for await (const document of streamHistorySearchDocuments(
      documentsDirectory,
      "abort line match",
      INDEXED_KEY_OPTIONS,
      undefined,
      controller.signal
    )) {
      results.push(document);
      controller.abort();
    }

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.text, "abort line match first");
  });

  test("visits shards in descending run startedAt order using the manifest", async () => {
    await writeShard(getDocumentsShardFileName("run-old"), [
      createDocument("order-term old", 100),
    ]);
    await writeShard(getDocumentsShardFileName("run-new"), [
      createDocument("order-term new", 300),
    ]);
    await writeShard(getDocumentsShardFileName("run-mid"), [
      createDocument("order-term mid", 200),
    ]);
    const indexedRuns = createIndexedRuns([
      { manifestPath: "run-old", startedAt: 100 },
      { manifestPath: "run-new", startedAt: 300 },
      { manifestPath: "run-mid", startedAt: 200 },
    ]);

    const results: HistorySearchDocument[] = [];
    for await (const document of streamHistorySearchDocuments(
      documentsDirectory,
      "order-term",
      { ...INDEXED_KEY_OPTIONS, indexedRuns }
    )) {
      results.push(document);
    }

    assert.deepStrictEqual(
      results.map((document) => document.text),
      ["order-term new", "order-term mid", "order-term old"]
    );
  });

  test("derives startedAt from its first document for a shard the manifest doesn't know about", async () => {
    // A shard can exist on disk without a manifest entry (an in-flight write,
    // or a manifest that failed to load). It must still be scanned, and its
    // position derived from its own content rather than dropped or guessed.
    await writeShard("orphan-shard.jsonl", [
      createDocument("order-term orphan", 250),
    ]);
    await writeShard(getDocumentsShardFileName("run-known"), [
      createDocument("order-term known", 100),
    ]);
    const indexedRuns = createIndexedRuns([
      { manifestPath: "run-known", startedAt: 100 },
    ]);

    const results: HistorySearchDocument[] = [];
    for await (const document of streamHistorySearchDocuments(
      documentsDirectory,
      "order-term",
      { ...INDEXED_KEY_OPTIONS, indexedRuns }
    )) {
      results.push(document);
    }

    assert.deepStrictEqual(
      results.map((document) => document.text),
      ["order-term orphan", "order-term known"]
    );
  });

  test("carries manifest source metadata only for manifest-known shards", async () => {
    const knownManifestPath = "run-known-metadata";
    const knownShardName = getDocumentsShardFileName(knownManifestPath);
    await writeShard(knownShardName, [
      createDocument("metadata-term known", 200),
    ]);
    await writeShard("unknown-metadata.jsonl", [
      createDocument("metadata-term unknown", 100),
    ]);

    const indexedRuns = createIndexedRuns([
      { manifestPath: knownManifestPath, startedAt: 200 },
    ]);
    indexedRuns[knownManifestPath].overCapCandidateCount = 3;

    const entries = await listDocumentShardEntries(
      documentsDirectory,
      indexedRuns
    );
    const knownEntry = entries.find(
      (entry) => entry.shardName === knownShardName
    );
    const unknownEntry = entries.find(
      (entry) => entry.shardName === "unknown-metadata.jsonl"
    );

    assert.ok(knownEntry);
    assert.strictEqual(knownEntry.manifestPath, knownManifestPath);
    assert.strictEqual(knownEntry.overCapCandidateCount, 3);
    assert.ok(unknownEntry);
    assert.strictEqual(unknownEntry.manifestPath, undefined);
    assert.strictEqual(unknownEntry.overCapCandidateCount, undefined);
  });

  test("groups shards with an equal startedAt deterministically instead of dropping either", async () => {
    const tiedShardNameA = getDocumentsShardFileName("run-tied-a");
    const tiedShardNameB = getDocumentsShardFileName("run-tied-b");
    await writeShard(tiedShardNameA, [
      createDocument("order-term tied-a", 200),
    ]);
    await writeShard(tiedShardNameB, [
      createDocument("order-term tied-b", 200),
    ]);
    const indexedRuns = createIndexedRuns([
      { manifestPath: "run-tied-a", startedAt: 200 },
      { manifestPath: "run-tied-b", startedAt: 200 },
    ]);

    const order = await resolveShardVisitOrder(
      documentsDirectory,
      // Listing order need not match visit order; feed it in reverse.
      [tiedShardNameB, tiedShardNameA],
      indexedRuns
    );

    assert.deepStrictEqual(
      order,
      [tiedShardNameA, tiedShardNameB].sort((left, right) =>
        left.localeCompare(right)
      )
    );

    const results: HistorySearchDocument[] = [];
    for await (const document of streamHistorySearchDocuments(
      documentsDirectory,
      "order-term",
      { ...INDEXED_KEY_OPTIONS, indexedRuns }
    )) {
      results.push(document);
    }
    assert.deepStrictEqual(
      new Set(results.map((document) => document.text)),
      new Set(["order-term tied-a", "order-term tied-b"])
    );
  });

  function createIndexedRuns(
    entries: { manifestPath: string; startedAt: number }[]
  ): HistorySearchIndexManifest["indexedRuns"] {
    const indexedRuns: HistorySearchIndexManifest["indexedRuns"] = {};
    for (const { manifestPath, startedAt } of entries) {
      indexedRuns[manifestPath] = {
        manifestPath,
        eventsPath: `${manifestPath}-events`,
        workflowId: manifestPath,
        runId: 1,
        startedAt,
        eventCount: 1,
        lastUpdatedAt: startedAt,
        sourceManifestMtimeMs: startedAt,
        sourceEventsMtimeMs: startedAt,
      };
    }
    return indexedRuns;
  }

  async function matchingTexts(
    query: string,
    options = INDEXED_KEY_OPTIONS
  ): Promise<string[]> {
    const matches: string[] = [];
    for await (const document of streamHistorySearchDocuments(
      documentsDirectory,
      query,
      options
    )) {
      if (document.text.toLowerCase().includes(query.toLowerCase())) {
        matches.push(document.text);
      }
    }
    return matches;
  }

  async function writeShard(
    fileName: string,
    documents: HistorySearchDocument[]
  ): Promise<string> {
    const shardPath = path.join(documentsDirectory, fileName);
    await fs.writeFile(
      shardPath,
      documents.map((document) => JSON.stringify(document)).join("\n") + "\n",
      "utf8"
    );
    return shardPath;
  }

  function createLegacyDocument(
    text: string
  ): Omit<HistorySearchDocument, "textLower"> {
    const { textLower: _unusedTextLower, ...legacy } = createDocument(text);
    return legacy;
  }

  function createDocument(text: string, startedAt = 1): HistorySearchDocument {
    return {
      id: `document-${text}`,
      workflowKey: "scanner-workflow" as WorkflowKey,
      runRef: "scanner-run" as RunRef,
      workflowName: "Scanner workflow",
      runId: 1,
      startedAt,
      executionState: "completed",
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      sequence: 1,
      timestampMs: 1,
      eventKind: HISTORY_EVENT_KINDS.STATUS,
      matchField: HISTORY_MATCH_FIELDS.OUTPUT,
      text,
      textLower: text.toLowerCase(),
    };
  }
});
