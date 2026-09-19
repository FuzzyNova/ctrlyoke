#!/usr/bin/env node

/**
 * Measurement spike for dev/backlog/HISTORY_SEARCH_TRUNCATED_TEXT_MATCH_PLAN.md.
 *
 * Answers the three numbers that plan's acceptance criteria gate an option on,
 * against a real schema-4.2.0 index plus the run history it was built from:
 *
 *   1. Added documents — how many candidates exceed `MAX_INDEXED_TEXT_LENGTH`
 *      today, and how many extra documents option A (overlapping windows) or
 *      option C (first + last anchor windows) would produce for them.
 *   2. On-disk growth — projected shard bytes, derived from the *measured*
 *      per-document non-text overhead and JSON escape factor of the real
 *      index, remembering that every document stores `text` and `textLower`.
 *   3. Cache fit — how many runs fit in the `runs.historySearchCacheMb`
 *      budget (`HistorySearchDocumentCache`, recency-ordered) before and
 *      after, using the real `estimateHistorySearchDocumentBytes`.
 *
 * It re-extracts candidates from `events.jsonl` with the real
 * `HistoryCandidateExtractor` and **no** `maxTextLength`, which is the only
 * way to recover the pre-truncation lengths the index no longer holds.
 *
 * Usage:
 *   node --max-old-space-size=4096 scripts/spike-history-search-truncation.mjs \
 *     <projectStateRoot> [--overlap 200] [--budget-mb 320] [--sample N] [--json out.json]
 *
 * `<projectStateRoot>` is the directory holding `.search-index/` and `.runs/`
 * (e.g. `~/.ctrlyoke/projects/<slug>-<hash12>`). Everything is read only.
 */

import Module from "node:module";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const MAX_INDEXED_TEXT_LENGTH = 2000;
const MEGABYTE = 1024 * 1024;
const DEFAULT_OVERLAP = 200;
const DEFAULT_BUDGET_MB = 320;
const TIMELINE_EVENT_TYPES = {
  CLI_OUTPUT_RECORDED: "cliOutputRecorded",
  CLI_OUTPUT_EVENTS_APPENDED: "cliOutputEventsAppended",
  STATUS_MESSAGE_RECORDED: "statusMessageRecorded",
};

function parseArgs(argv) {
  const positional = [];
  const options = {
    overlap: DEFAULT_OVERLAP,
    budgetMb: DEFAULT_BUDGET_MB,
    sample: undefined,
    json: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--overlap":
        options.overlap = Number(argv[++index]);
        break;
      case "--budget-mb":
        options.budgetMb = Number(argv[++index]);
        break;
      case "--sample":
        options.sample = Number(argv[++index]);
        break;
      case "--json":
        options.json = argv[++index];
        break;
      default:
        positional.push(arg);
    }
  }
  return { positional, options };
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
    const extractorModule = await import(
      pathToFileURL(
        resolve("out/core/orchestration/HistoryCandidateExtractor.js")
      ).href
    );
    const cacheModule = await import(
      pathToFileURL(
        resolve("out/core/orchestration/HistorySearchDocumentCache.js")
      ).href
    );
    const workerModule = await import(
      pathToFileURL(
        resolve("out/core/orchestration/historySearchRebuildWorker.js")
      ).href
    );
    return {
      HistoryCandidateExtractor: extractorModule.HistoryCandidateExtractor,
      estimateHistorySearchDocumentBytes:
        cacheModule.estimateHistorySearchDocumentBytes,
      getDocumentsShardFileName: workerModule.getDocumentsShardFileName,
    };
  } finally {
    restore();
  }
}

/** Mirrors `historySearchRebuildWorker.collectEventCandidates`. */
function collectEventCandidates(event, extractor) {
  switch (event.eventType) {
    case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED:
      return extractor.collectCliOutputCandidates(event.payload.cliOutput);
    case TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED:
      return extractor.collectStructuredEventsCandidates(event.payload.events);
    case TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED:
      return extractor.collectStatusCandidates(
        event.payload.statusMessage.message
      );
    default:
      return [];
  }
}

/**
 * Windows a candidate of `length` chars into bounded, overlapping windows of
 * `MAX_INDEXED_TEXT_LENGTH` (option A). Returns the window count and the total
 * stored chars across them — the overlap is stored twice, which is exactly the
 * cost the plan asks to size.
 */
function windowPlan(length, overlap) {
  if (length <= MAX_INDEXED_TEXT_LENGTH) {
    return { windows: 1, storedChars: length };
  }
  const stride = MAX_INDEXED_TEXT_LENGTH - overlap;
  const windows = 1 + Math.ceil((length - MAX_INDEXED_TEXT_LENGTH) / stride);
  const lastStart = (windows - 1) * stride;
  const storedChars =
    (windows - 1) * MAX_INDEXED_TEXT_LENGTH + (length - lastStart);
  return { windows, storedChars };
}

/** Option C: today's prefix, plus a suffix window past `2 * MAX_INDEXED_TEXT_LENGTH`. */
function anchorPlan(length) {
  if (length <= MAX_INDEXED_TEXT_LENGTH) {
    return { windows: 1, storedChars: length };
  }
  if (length <= 2 * MAX_INDEXED_TEXT_LENGTH) {
    return { windows: 1, storedChars: MAX_INDEXED_TEXT_LENGTH };
  }
  return { windows: 2, storedChars: 2 * MAX_INDEXED_TEXT_LENGTH };
}

async function* streamJsonLines(filePath) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A partially written trailing line; the real scanner skips it too.
      continue;
    }
    yield { line, parsed };
  }
}

/**
 * Reads one shard to recover what the index actually stores today: document
 * count, on-disk bytes, and the split between escaped text payload and
 * everything else, which is what lets growth be projected from measured
 * constants rather than assumed ones.
 */
async function measureShard(shardPath, estimateBytes) {
  let documents = 0;
  let truncatedDocuments = 0;
  let textChars = 0;
  let escapedTextChars = 0;
  let lineChars = 0;
  let cacheBytes = 0;
  for await (const { line, parsed } of streamJsonLines(shardPath)) {
    documents += 1;
    const text = parsed.text ?? "";
    const textLower = parsed.textLower ?? "";
    if (text.length >= MAX_INDEXED_TEXT_LENGTH) {
      truncatedDocuments += 1;
    }
    textChars += text.length + textLower.length;
    escapedTextChars +=
      JSON.stringify(text).length - 2 + JSON.stringify(textLower).length - 2;
    lineChars += line.length + 1;
    cacheBytes += estimateBytes(parsed);
  }
  const diskBytes = (await stat(shardPath)).size;
  return {
    documents,
    truncatedDocuments,
    textChars,
    escapedTextChars,
    lineChars,
    diskBytes,
    cacheBytes,
  };
}

/** Re-extracts a run's candidates uncapped and sizes each option against them. */
async function measureRunCandidates(eventsPath, extractor, overlap) {
  const totals = {
    candidates: 0,
    overCapCandidates: 0,
    uncappedChars: 0,
    cappedChars: 0,
    lostChars: 0,
    longestCandidate: 0,
    windowedDocuments: 0,
    windowedChars: 0,
    anchoredDocuments: 0,
    anchoredChars: 0,
  };
  for await (const { parsed: event } of streamJsonLines(eventsPath)) {
    // The rebuild worker drops candidates from any event without a `target`,
    // so counting them here would overstate the baseline it is compared to.
    if (!event.target) {
      continue;
    }
    let candidates;
    try {
      candidates = collectEventCandidates(event, extractor);
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      const length = candidate.text.length;
      totals.candidates += 1;
      totals.uncappedChars += length;
      totals.cappedChars += Math.min(length, MAX_INDEXED_TEXT_LENGTH);
      if (length > MAX_INDEXED_TEXT_LENGTH) {
        totals.overCapCandidates += 1;
        totals.lostChars += length - MAX_INDEXED_TEXT_LENGTH;
      }
      if (length > totals.longestCandidate) {
        totals.longestCandidate = length;
      }
      const windowed = windowPlan(length, overlap);
      totals.windowedDocuments += windowed.windows;
      totals.windowedChars += windowed.storedChars;
      const anchored = anchorPlan(length);
      totals.anchoredDocuments += anchored.windows;
      totals.anchoredChars += anchored.storedChars;
    }
  }
  return totals;
}

/**
 * Counts how many of the most recent runs fit in the cache budget, mirroring
 * `HistorySearchDocumentCache`: recency-ordered (newest first), and a single
 * run larger than the whole budget is skipped rather than evicting everything.
 */
function countRunsFittingBudget(runs, budgetBytes, bytesOf) {
  const ordered = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  let used = 0;
  let fitted = 0;
  for (const run of ordered) {
    const bytes = bytesOf(run);
    if (bytes > budgetBytes) {
      continue;
    }
    if (used + bytes > budgetBytes) {
      break;
    }
    used += bytes;
    fitted += 1;
  }
  return { fitted, usedMb: Number((used / MEGABYTE).toFixed(1)) };
}

function toMb(bytes) {
  return Number((bytes / MEGABYTE).toFixed(1));
}

/**
 * Times an uncapped, single-run candidate scan at a few points of the run-size
 * distribution — the cost option B's "search this run directly" fallback would
 * pay, which is the one number that decides whether that fallback is viable.
 */
async function measureSingleRunScanCost(indexedRuns, extractor, overlap) {
  const sized = [];
  for (const run of indexedRuns) {
    try {
      sized.push({ run, bytes: (await stat(run.eventsPath)).size });
    } catch {
      // Run deleted since the index was built.
    }
  }
  if (sized.length === 0) {
    return undefined;
  }
  sized.sort((a, b) => a.bytes - b.bytes);
  const at = (quantile) =>
    sized[Math.min(sized.length - 1, Math.floor(sized.length * quantile))];
  const samples = {
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sized[sized.length - 1],
  };
  const timings = {};
  for (const [label, entry] of Object.entries(samples)) {
    const startedAt = performance.now();
    await measureRunCandidates(entry.run.eventsPath, extractor, overlap);
    timings[label] = {
      eventsMb: Number((entry.bytes / MEGABYTE).toFixed(2)),
      scanMs: Number((performance.now() - startedAt).toFixed(0)),
    };
  }
  return timings;
}

function pct(value, total) {
  return total === 0 ? 0 : Number(((value / total) * 100).toFixed(2));
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const stateRoot = resolve(positional[0] ?? "");
  if (!positional[0]) {
    throw new Error(
      "usage: spike-history-search-truncation.mjs <projectStateRoot> [--overlap N] [--budget-mb N] [--sample N] [--json out.json]"
    );
  }

  const {
    HistoryCandidateExtractor,
    estimateHistorySearchDocumentBytes,
    getDocumentsShardFileName,
  } = await loadModules();

  const indexDirectory = join(stateRoot, ".search-index");
  const documentsDirectory = join(indexDirectory, "documents");
  const manifest = JSON.parse(
    await readFile(join(indexDirectory, "manifest.json"), "utf8")
  );
  if (manifest.schemaVersion !== "4.2.0") {
    console.warn(
      `WARNING: index schema is ${manifest.schemaVersion}, not 4.2.0 — the textLower doubling this spike assumes may not apply.`
    );
  }

  // Uncapped on purpose: recovering the pre-truncation candidate lengths is
  // the entire point, and the capped extractor is what threw them away.
  const extractor = new HistoryCandidateExtractor({});

  let indexedRuns = Object.values(manifest.indexedRuns ?? {});
  indexedRuns.sort((a, b) => b.startedAt - a.startedAt);
  if (options.sample && options.sample < indexedRuns.length) {
    // Evenly spaced across the recency range rather than the newest N, so a
    // sample is representative of the whole history's shape.
    const step = indexedRuns.length / options.sample;
    indexedRuns = Array.from(
      { length: options.sample },
      (_, index) => indexedRuns[Math.floor(index * step)]
    );
  }

  console.log(
    `schemaVersion=${manifest.schemaVersion} runs=${indexedRuns.length}/${Object.keys(manifest.indexedRuns ?? {}).length} overlap=${options.overlap} budgetMb=${options.budgetMb}`
  );

  const startedAtMs = performance.now();
  const runs = [];
  const totals = {
    shardDocuments: 0,
    shardTruncatedDocuments: 0,
    shardTextChars: 0,
    shardEscapedTextChars: 0,
    shardLineChars: 0,
    shardDiskBytes: 0,
    shardCacheBytes: 0,
    candidates: 0,
    overCapCandidates: 0,
    uncappedChars: 0,
    cappedChars: 0,
    lostChars: 0,
    longestCandidate: 0,
    windowedDocuments: 0,
    windowedChars: 0,
    anchoredDocuments: 0,
    anchoredChars: 0,
    runsRead: 0,
    runsMissing: 0,
  };

  for (const [index, run] of indexedRuns.entries()) {
    const shardPath = join(
      documentsDirectory,
      getDocumentsShardFileName(run.manifestPath)
    );
    let shard;
    let candidates;
    try {
      shard = await measureShard(shardPath, estimateHistorySearchDocumentBytes);
      candidates = await measureRunCandidates(
        run.eventsPath,
        extractor,
        options.overlap
      );
    } catch {
      totals.runsMissing += 1;
      continue;
    }
    totals.runsRead += 1;
    totals.shardDocuments += shard.documents;
    totals.shardTruncatedDocuments += shard.truncatedDocuments;
    totals.shardTextChars += shard.textChars;
    totals.shardEscapedTextChars += shard.escapedTextChars;
    totals.shardLineChars += shard.lineChars;
    totals.shardDiskBytes += shard.diskBytes;
    totals.shardCacheBytes += shard.cacheBytes;
    totals.candidates += candidates.candidates;
    totals.overCapCandidates += candidates.overCapCandidates;
    totals.uncappedChars += candidates.uncappedChars;
    totals.cappedChars += candidates.cappedChars;
    totals.lostChars += candidates.lostChars;
    totals.longestCandidate = Math.max(
      totals.longestCandidate,
      candidates.longestCandidate
    );
    totals.windowedDocuments += candidates.windowedDocuments;
    totals.windowedChars += candidates.windowedChars;
    totals.anchoredDocuments += candidates.anchoredDocuments;
    totals.anchoredChars += candidates.anchoredChars;

    runs.push({
      startedAt: run.startedAt,
      cacheBytes: shard.cacheBytes,
      documents: shard.documents,
      overCapCandidates: candidates.overCapCandidates,
      candidates: candidates.candidates,
      windowedDocuments: candidates.windowedDocuments,
      windowedChars: candidates.windowedChars,
      anchoredDocuments: candidates.anchoredDocuments,
      anchoredChars: candidates.anchoredChars,
      cappedChars: candidates.cappedChars,
    });

    if ((index + 1) % 100 === 0) {
      console.log(
        `  ...${index + 1}/${indexedRuns.length} runs (${Math.round((performance.now() - startedAtMs) / 1000)}s)`
      );
    }
  }

  // Measured constants, not assumed ones: how much JSON escaping inflates a
  // text char on disk, what the rest of a document's line costs, and how many
  // bytes a serialized char actually occupies (UTF-8, so >1 for non-ASCII).
  const escapeFactor =
    totals.shardTextChars === 0
      ? 1
      : totals.shardEscapedTextChars / totals.shardTextChars;
  const nonTextCharsPerDocument =
    totals.shardDocuments === 0
      ? 0
      : (totals.shardLineChars - totals.shardEscapedTextChars) /
        totals.shardDocuments;
  const diskBytesPerLineChar =
    totals.shardLineChars === 0
      ? 1
      : totals.shardDiskBytes / totals.shardLineChars;

  // `storedTextChars` counts `text` only; every document also stores
  // `textLower`, hence the factor of 2.
  const projectDiskBytes = (documents, storedTextChars) =>
    (documents * nonTextCharsPerDocument + storedTextChars * 2 * escapeFactor) *
    diskBytesPerLineChar;

  const baselineDiskBytes = totals.shardDiskBytes;
  const windowedDiskBytes = projectDiskBytes(
    totals.windowedDocuments,
    totals.windowedChars
  );
  const anchoredDiskBytes = projectDiskBytes(
    totals.anchoredDocuments,
    totals.anchoredChars
  );

  const budgetBytes = options.budgetMb * MEGABYTE;
  // Cache bytes scale with a run's stored text (estimateHistorySearchDocumentBytes
  // sums every string field, so `textLower` counts too) plus the fixed
  // per-document overhead each extra window also pays.
  const OBJECT_OVERHEAD_BYTES = 400;
  const projectCacheBytes = (run, documents, storedTextChars) => {
    const baselineTextBytes = run.cappedChars * 2 * 2;
    const baselineOverhead = run.documents * OBJECT_OVERHEAD_BYTES;
    const nonTextFieldBytes = Math.max(
      0,
      run.cacheBytes - baselineTextBytes - baselineOverhead
    );
    const perDocumentNonText =
      run.documents === 0 ? 0 : nonTextFieldBytes / run.documents;
    return (
      storedTextChars * 2 * 2 +
      documents * (OBJECT_OVERHEAD_BYTES + perDocumentNonText)
    );
  };

  const baselineFit = countRunsFittingBudget(
    runs,
    budgetBytes,
    (run) => run.cacheBytes
  );
  const windowedFit = countRunsFittingBudget(runs, budgetBytes, (run) =>
    projectCacheBytes(run, run.windowedDocuments, run.windowedChars)
  );
  const anchoredFit = countRunsFittingBudget(runs, budgetBytes, (run) =>
    projectCacheBytes(run, run.anchoredDocuments, run.anchoredChars)
  );

  const report = {
    inputs: {
      stateRoot,
      schemaVersion: manifest.schemaVersion,
      runsMeasured: totals.runsRead,
      runsUnreadable: totals.runsMissing,
      overlapChars: options.overlap,
      cacheBudgetMb: options.budgetMb,
      elapsedSeconds: Number(
        ((performance.now() - startedAtMs) / 1000).toFixed(1)
      ),
    },
    today: {
      documents: totals.shardDocuments,
      documentsAtCap: totals.shardTruncatedDocuments,
      documentsAtCapPct: pct(
        totals.shardTruncatedDocuments,
        totals.shardDocuments
      ),
      candidatesOverCap: totals.overCapCandidates,
      candidatesOverCapPct: pct(totals.overCapCandidates, totals.candidates),
      longestCandidateChars: totals.longestCandidate,
      indexedChars: totals.cappedChars,
      unindexedChars: totals.lostChars,
      unindexedPctOfAllText: pct(totals.lostChars, totals.uncappedChars),
      diskMb: toMb(baselineDiskBytes),
      // How often option B's per-run affordance would have something to offer.
      runsWithOverCapCandidates: runs.filter((run) => run.overCapCandidates > 0)
        .length,
      runsWithOverCapCandidatesPct: pct(
        runs.filter((run) => run.overCapCandidates > 0).length,
        runs.length
      ),
    },
    optionA_windows: {
      documents: totals.windowedDocuments,
      addedDocuments: totals.windowedDocuments - totals.candidates,
      documentMultiplier: Number(
        (totals.windowedDocuments / Math.max(totals.candidates, 1)).toFixed(2)
      ),
      storedChars: totals.windowedChars,
      diskMb: toMb(windowedDiskBytes),
      diskMultiplier: Number(
        (windowedDiskBytes / Math.max(baselineDiskBytes, 1)).toFixed(2)
      ),
      runsInCacheBudget: windowedFit.fitted,
    },
    optionC_anchors: {
      documents: totals.anchoredDocuments,
      addedDocuments: totals.anchoredDocuments - totals.candidates,
      documentMultiplier: Number(
        (totals.anchoredDocuments / Math.max(totals.candidates, 1)).toFixed(2)
      ),
      storedChars: totals.anchoredChars,
      diskMb: toMb(anchoredDiskBytes),
      diskMultiplier: Number(
        (anchoredDiskBytes / Math.max(baselineDiskBytes, 1)).toFixed(2)
      ),
      runsInCacheBudget: anchoredFit.fitted,
      interiorCharsStillUnindexed: totals.uncappedChars - totals.anchoredChars,
    },
    optionB_perRunFallback: {
      addedDocuments: 0,
      diskMultiplier: 1,
      runsInCacheBudget: baselineFit.fitted,
      singleRunScanCost: await measureSingleRunScanCost(
        indexedRuns,
        extractor,
        options.overlap
      ),
    },
    cacheFit: {
      budgetMb: options.budgetMb,
      runsMeasured: runs.length,
      today: baselineFit,
      optionA: windowedFit,
      optionC: anchoredFit,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (options.json) {
    await writeFile(options.json, JSON.stringify(report, null, 2), "utf8");
    console.log(`wrote ${options.json}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error
  );
  process.exitCode = 1;
}
