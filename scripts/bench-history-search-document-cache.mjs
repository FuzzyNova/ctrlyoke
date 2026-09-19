#!/usr/bin/env node

/**
 * Measure `HistorySearchDocumentCache`'s effect on a realistic multi-search
 * session against a real, on-disk `.search-index` directory: simulates the
 * ~20 searches/session figure from
 * dev/implemented/HISTORY_SEARCH_RESPONSIVE_QUERY_PLAN.md, sharing one cache
 * instance across every query (as one live `HistorySearchIndexService` does
 * for one workspace), and reports the process's memory footprint before and
 * after so it can be checked against the configured budget.
 *
 * Usage:
 *   node --expose-gc scripts/bench-history-search-document-cache.mjs <.search-index> [budgetMb]
 *
 * Run with --expose-gc: without it, heapUsed/rss reflect whatever garbage
 * the most recent query happened to leave uncollected rather than steady
 * state, which made repeated runs at the same budget disagree by 2-3x.
 *
 * The index directory is read only.
 */

import Module from "node:module";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const DOCUMENTS_DIRECTORY_NAME = "documents";
const MEGABYTE = 1024 * 1024;
const DEFAULT_BUDGET_MB = 1024;

// A representative session: repeats, prefix-typing, and a rare/no-match
// query, mirroring the real session logged in the responsive-query plan.
const SESSION_QUERIES = [
  "codemirroreditor",
  "okay",
  "okay",
  "codemirroreditor",
  "co",
  "but why",
  "codemirror",
  "the",
  "search",
  "workflow",
  "error",
  "prompt",
  "harness",
  "commit",
  "rebuild",
  "cache",
  "history",
  "zzzzzzzzzz-no-match",
  "okay",
  "codemirroreditor",
];

function readMemory() {
  // Force a GC pass before sampling (run with --expose-gc) so the reading
  // reflects steady-state retained memory rather than not-yet-collected
  // garbage from the query that happened to run just before this call.
  if (typeof global.gc === "function") {
    global.gc();
    global.gc();
  }
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, rss: usage.rss };
}

function toMegabytes(bytes) {
  return Number((bytes / MEGABYTE).toFixed(1));
}

function loadWithVscodeShim() {
  const originalLoad = Module._load;
  Module._load = function loadWithoutVSCode(request, parent, isMain) {
    if (request === "vscode") {
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => {
    Module._load = originalLoad;
  };
}

async function loadModules() {
  const restore = loadWithVscodeShim();
  try {
    const cacheModule = await import(
      pathToFileURL(
        resolve("out/core/orchestration/HistorySearchDocumentCache.js")
      ).href
    );
    const scannerModule = await import(
      pathToFileURL(
        resolve("out/core/orchestration/HistorySearchShardScanner.js")
      ).href
    );
    return { ...cacheModule, ...scannerModule };
  } finally {
    restore();
  }
}

async function loadManifest(indexDirectory) {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(
      await readFile(join(indexDirectory, "manifest.json"), "utf8")
    );
  } catch {
    return undefined;
  }
}

/** Mirrors `HistorySearchIndexService.scanForMatches`'s per-shard cache decision, simplified (no group/dedupe bookkeeping — this script measures memory, not result correctness, which the real unit tests already cover). */
async function runQuery(
  documentsDir,
  shardOrder,
  query,
  cache,
  { readShardDocuments, streamHistorySearchDocuments },
  hasPersistedLowercaseKey
) {
  const lowered = query.toLowerCase();
  const limit = 50;
  let matches = 0;
  let documentsScanned = 0;

  for (const shard of shardOrder) {
    if (matches >= limit) break;

    const cached = cache.get(shard.shardName);
    if (cached) {
      documentsScanned += cached.length;
      for (const document of cached) {
        if (document.text.toLowerCase().includes(lowered)) matches += 1;
      }
      continue;
    }

    if (cache.wouldRetain(shard.startedAt)) {
      const { documents, complete } = await readShardDocuments(
        documentsDir,
        shard.shardName
      );
      documentsScanned += documents.length;
      for (const document of documents) {
        if (document.text.toLowerCase().includes(lowered)) matches += 1;
      }
      if (complete) {
        cache.set(shard.shardName, shard.startedAt, documents);
      }
      continue;
    }

    for await (const document of streamHistorySearchDocuments(
      documentsDir,
      query,
      { hasPersistedLowercaseKey, resolvedShardOrder: [shard.shardName] }
    )) {
      documentsScanned += 1;
      if (document.text.toLowerCase().includes(lowered)) matches += 1;
    }
  }

  return { matches, documentsScanned };
}

async function main() {
  const indexDirectory = resolve(process.argv[2]);
  const budgetMb = Number(process.argv[3] ?? DEFAULT_BUDGET_MB);
  if (!indexDirectory || Number.isNaN(budgetMb)) {
    throw new Error(
      "usage: bench-history-search-document-cache.mjs <.search-index> [budgetMb]"
    );
  }

  const {
    HistorySearchDocumentCache,
    listDocumentShardEntries,
    readShardDocuments,
    streamHistorySearchDocuments,
  } = await loadModules();

  const documentsDir = join(indexDirectory, DOCUMENTS_DIRECTORY_NAME);
  const manifest = await loadManifest(indexDirectory);
  const hasPersistedLowercaseKey = manifest?.schemaVersion === "4.2.0";
  const shardOrder = await listDocumentShardEntries(
    documentsDir,
    hasPersistedLowercaseKey ? manifest?.indexedRuns : undefined
  );

  console.log(
    `shards=${shardOrder.length} schemaVersion=${manifest?.schemaVersion ?? "unknown"} budgetMb=${budgetMb} queries=${SESSION_QUERIES.length}`
  );

  const cache = new HistorySearchDocumentCache(budgetMb * MEGABYTE);
  const baseline = readMemory();
  const sessionStart = performance.now();
  const perQuery = [];

  for (const query of SESSION_QUERIES) {
    const queryStart = performance.now();
    const result = await runQuery(
      documentsDir,
      shardOrder,
      query,
      cache,
      { readShardDocuments, streamHistorySearchDocuments },
      hasPersistedLowercaseKey
    );
    perQuery.push({
      query,
      ...result,
      ms: Number((performance.now() - queryStart).toFixed(1)),
    });
  }

  const sessionMs = performance.now() - sessionStart;
  const final = readMemory();

  console.log(JSON.stringify(perQuery, null, 2));
  console.log(
    JSON.stringify(
      {
        sessionMs: Number(sessionMs.toFixed(1)),
        baselineHeapUsedMb: toMegabytes(baseline.heapUsed),
        baselineRssMb: toMegabytes(baseline.rss),
        finalHeapUsedMb: toMegabytes(final.heapUsed),
        finalRssMb: toMegabytes(final.rss),
        heapUsedDeltaMb: toMegabytes(final.heapUsed - baseline.heapUsed),
        rssDeltaMb: toMegabytes(final.rss - baseline.rss),
        configuredBudgetMb: budgetMb,
      },
      null,
      2
    )
  );
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error
  );
  process.exitCode = 1;
}
