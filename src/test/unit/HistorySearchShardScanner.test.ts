import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import {
  createHistorySearchLinePrefilter,
  streamHistorySearchDocuments,
} from "../../core/orchestration/HistorySearchShardScanner";
import {
  HISTORY_EVENT_KINDS,
  HISTORY_MATCH_FIELDS,
} from "../../types/DashboardConstants";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import { FINAL_STEP_PHASES } from "../../types/DashboardConstants";
import type { HistorySearchDocument } from "../../types/WorkflowTimelineTypes";

suite("HistorySearchShardScanner", () => {
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

  test("never rejects a line whose parsed text really matches", () => {
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
          createHistorySearchLinePrefilter(query)(line),
          true,
          `prefilter rejected generated match for query ${JSON.stringify(query)}`
        );
      }
    }
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
      "match"
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

  async function matchingTexts(query: string): Promise<string[]> {
    const matches: string[] = [];
    for await (const document of streamHistorySearchDocuments(
      documentsDirectory,
      query
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

  function createDocument(text: string): HistorySearchDocument {
    return {
      id: `document-${text}`,
      workflowKey: "scanner-workflow" as WorkflowKey,
      runRef: "scanner-run" as RunRef,
      workflowName: "Scanner workflow",
      runId: 1,
      startedAt: 1,
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
