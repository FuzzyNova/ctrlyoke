/**
 * Adapter from FlightPath's internal UnifiedDiffHunk format to react-diff-view's HunkData format.
 *
 * Two entry points:
 *  - toRdvHunks()       — structured patch (e.g. from Claude) → HunkData[]
 *  - toRdvFromContent() — raw old/new file content → { hunks, diffType }
 *
 * Also exports the configured refractor instance for use in DiffView's tokenize call.
 */
import * as DiffLib from "diff";
import { parseDiff } from "react-diff-view";
import type { HunkData, ChangeData, DiffType, ViewType } from "react-diff-view";
import { refractor as refractorCore } from "refractor/core";
import refractorTypescript from "refractor/typescript";
import refractorTsx from "refractor/tsx";
import refractorJavascript from "refractor/javascript";
import refractorJsx from "refractor/jsx";
import refractorPython from "refractor/python";
import refractorBash from "refractor/bash";
import refractorJson from "refractor/json";
import refractorYaml from "refractor/yaml";
import refractorCss from "refractor/css";
import refractorMarkup from "refractor/markup";
import refractorMarkdown from "refractor/markdown";
import refractorRust from "refractor/rust";
import refractorGo from "refractor/go";
import refractorJava from "refractor/java";
import refractorCsharp from "refractor/csharp";
import refractorC from "refractor/c";
import refractorCpp from "refractor/cpp";
import { normalizeStructuredPatch } from "./diffUtils";
import type { UnifiedDiffHunk } from "../types/cliEvents";

// Register the Prism grammars used by DiffView highlighting.
refractorCore.register(refractorTypescript);
refractorCore.register(refractorTsx);
refractorCore.register(refractorJavascript);
refractorCore.register(refractorJsx);
refractorCore.register(refractorPython);
refractorCore.register(refractorBash);
refractorCore.register(refractorJson);
refractorCore.register(refractorYaml);
refractorCore.register(refractorCss);
refractorCore.register(refractorMarkup);
refractorCore.register(refractorMarkdown);
refractorCore.register(refractorRust);
refractorCore.register(refractorGo);
refractorCore.register(refractorJava);
refractorCore.register(refractorCsharp);
refractorCore.register(refractorC);
refractorCore.register(refractorCpp);

/**
 * react-diff-view expects refractor.highlight() to return a node array.
 * Modern refractor returns a `{ type: "root", children }` wrapper instead,
 * so adapt it here to the shape tokenize() expects.
 */
export const refractor = {
  highlight(value: string, language: string) {
    const result = refractorCore.highlight(value, language);
    return Array.isArray(result) ? result : result.children;
  },
  registered(aliasOrLanguage: string) {
    return refractorCore.registered(aliasOrLanguage);
  },
};

export interface RenderedDiffRun {
  count: number;
  addedLines: number;
  removedLines: number;
}

function isDisplayableLine(line: string): boolean {
  return !(
    line === "\\ No newline at end of file" ||
    line.startsWith("@@ ") ||
    line.startsWith("diff --git ") ||
    line.startsWith("index ")
  );
}

export function toRdvHunks(hunks: UnifiedDiffHunk[]): HunkData[] {
  const normalized = normalizeStructuredPatch(hunks);
  return normalized.map((hunk): HunkData => {
    const changes: ChangeData[] = [];
    let oldLineNumber = hunk.oldStart;
    let newLineNumber = hunk.newStart;

    for (const line of hunk.lines) {
      if (!isDisplayableLine(line)) continue;
      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === "+") {
        changes.push({
          type: "insert",
          isInsert: true,
          lineNumber: newLineNumber,
          content,
        });
        newLineNumber++;
      } else if (prefix === "-") {
        changes.push({
          type: "delete",
          isDelete: true,
          lineNumber: oldLineNumber,
          content,
        });
        oldLineNumber++;
      } else if (prefix === " ") {
        changes.push({
          type: "normal",
          isNormal: true,
          oldLineNumber,
          newLineNumber,
          content,
        });
        oldLineNumber++;
        newLineNumber++;
      }
    }

    return {
      content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      changes,
    };
  });
}

export function toRdvFromContent(
  oldContent: string,
  newContent: string
): { hunks: HunkData[]; diffType: DiffType } {
  const old = oldContent.replace(/\r\n/g, "\n");
  const next = newContent.replace(/\r\n/g, "\n");
  const rawPatch = DiffLib.createPatch("file", old, next);
  // parseDiff requires git-diff-style header; createPatch emits Index:/=== headers instead
  const patchLines = rawPatch.split("\n");
  const gitDiff = ["diff --git a/file b/file", ...patchLines.slice(2)].join(
    "\n"
  );
  const [file] = parseDiff(gitDiff, { nearbySequences: "zip" });
  return {
    hunks: (file?.hunks ?? []) as HunkData[],
    diffType: (file?.type as DiffType) ?? "modify",
  };
}

/** Map the language names from getLanguageFromPath() to refractor-registered names. */
export function normalizeLanguage(
  lang: string | undefined
): string | undefined {
  return lang;
}

function appendRenderedDiffRun(
  runs: RenderedDiffRun[],
  next: RenderedDiffRun
): void {
  const last = runs[runs.length - 1];
  if (
    last &&
    last.addedLines === next.addedLines &&
    last.removedLines === next.removedLines
  ) {
    last.count += next.count;
    return;
  }

  runs.push({ ...next });
}

/**
 * Convert react-diff-view hunks into the same rendered row model used by the UI.
 *
 * - `unified`: each diff change maps to one rendered row
 * - `split`: adjacent delete+insert changes share one rendered row
 */
export function getRenderedDiffStats(
  hunks: HunkData[],
  viewType: ViewType
): { added: number; removed: number; runs: RenderedDiffRun[] } {
  let added = 0;
  let removed = 0;
  const runs: RenderedDiffRun[] = [];

  const pushRow = (addedLines: number, removedLines: number) => {
    added += addedLines;
    removed += removedLines;
    appendRenderedDiffRun(runs, { count: 1, addedLines, removedLines });
  };

  for (const hunk of hunks) {
    if (viewType === "unified") {
      for (const change of hunk.changes) {
        if (change.type === "insert") {
          pushRow(1, 0);
        } else if (change.type === "delete") {
          pushRow(0, 1);
        } else {
          pushRow(0, 0);
        }
      }
      continue;
    }

    for (let i = 0; i < hunk.changes.length; i++) {
      const current = hunk.changes[i];

      if (current.type === "normal") {
        pushRow(0, 0);
        continue;
      }

      if (current.type === "delete") {
        const next = hunk.changes[i + 1];
        if (next?.type === "insert") {
          pushRow(1, 1);
          i++;
          continue;
        }

        pushRow(0, 1);
        continue;
      }

      pushRow(1, 0);
    }
  }

  return { added, removed, runs };
}
