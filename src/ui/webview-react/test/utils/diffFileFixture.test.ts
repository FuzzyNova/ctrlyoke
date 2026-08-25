import { describe, expect, it } from "vitest";
import type { HunkData } from "react-diff-view";
import type { DiffFileCardProps } from "@components/diff/DiffFileCard";
import {
  DIFF_FILE_CARD_BORDER_HEIGHT,
  DIFF_FILE_CARD_HEADER_BORDER_HEIGHT,
  DIFF_FILE_CARD_HEADER_LINE_HEIGHT,
  DIFF_FILE_CARD_HEADER_VERTICAL_PADDING,
  DIFF_FILE_CARD_NOTE_GAP,
  DIFF_FILE_DIFF_VIEW_MARGIN_HEIGHT,
  estimateDiffFileCardSize,
} from "@utils/diffFileRows";
import {
  buildDiffRenderPlan,
  toRdvFromContent,
  toRdvHunks,
} from "@utils/rdvAdapter";
import {
  DIFF_FILE_FIXTURE_SIZES,
  createDiffFileFixture,
  flattenDiffFileFixture,
} from "../fixtures/diffFileFixture";

const CALIBRATION_OPTIONS = {
  collapsed: false,
  viewType: "unified" as const,
  outputFontSize: 13,
  outputContentWidth: 800,
};
const NOTE_HORIZONTAL_CHROME = 40;
const HEADER_CHAR_WIDTH = 0.6;

function countWrappedNoteLines(note: string): number {
  const charsPerLine = Math.max(
    8,
    Math.floor(
      (CALIBRATION_OPTIONS.outputContentWidth - NOTE_HORIZONTAL_CHROME) /
        (CALIBRATION_OPTIONS.outputFontSize * HEADER_CHAR_WIDTH)
    )
  );
  return note
    .split(/\r?\n/)
    .reduce(
      (count, line) =>
        count + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0
    );
}

function realizedDiffBody(file: DiffFileCardProps): number {
  let hunks: HunkData[];
  switch (file.source.kind) {
    case "hunks":
      hunks = file.source.hunks;
      break;
    case "patch":
      hunks = toRdvHunks(file.source.structuredPatch);
      break;
    case "content":
      if (
        file.source.oldContent === undefined ||
        file.source.newContent === undefined
      ) {
        return 0;
      }
      hunks = toRdvFromContent(
        file.source.oldContent,
        file.source.newContent
      ).hunks;
      break;
    case "image":
    case "binary":
    case "deferred":
      return 0;
  }

  if (hunks.length === 0) {
    return file.source.kind === "content"
      ? buildDiffRenderPlan([], {
          ...CALIBRATION_OPTIONS,
          collapsed: true,
          hunks: [],
          layoutMode: "file-edit",
        }).diffBlockHeight
      : 0;
  }
  if (!hunks.some((hunk) => hunk.changes.length > 0)) {
    return 0;
  }
  return buildDiffRenderPlan(hunks, {
    ...CALIBRATION_OPTIONS,
    hunks,
    layoutMode: "file-edit",
  }).diffBlockHeight;
}

function realizedCardHeight(file: DiffFileCardProps): number {
  const hasDirectory = file.path.includes("/") || file.path.includes("\\");
  const hasOldDirectory =
    file.oldPath?.includes("/") || file.oldPath?.includes("\\");
  const pathLineCount = hasDirectory || hasOldDirectory ? 2 : 1;
  const noteLines = file.note ? countWrappedNoteLines(file.note) : 0;
  const body = realizedDiffBody(file);
  return (
    DIFF_FILE_CARD_BORDER_HEIGHT +
    DIFF_FILE_CARD_HEADER_BORDER_HEIGHT +
    DIFF_FILE_CARD_HEADER_VERTICAL_PADDING +
    pathLineCount * DIFF_FILE_CARD_HEADER_LINE_HEIGHT +
    (noteLines > 0
      ? DIFF_FILE_CARD_NOTE_GAP + noteLines * DIFF_FILE_CARD_HEADER_LINE_HEIGHT
      : 0) +
    (body > 0 ? DIFF_FILE_DIFF_VIEW_MARGIN_HEIGHT : 0) +
    body
  );
}

describe("diff file fixture", () => {
  it.each(DIFF_FILE_FIXTURE_SIZES)(
    "creates exactly %i files with the complete performance mix",
    (fileCount) => {
      const files = flattenDiffFileFixture(createDiffFileFixture(fileCount));
      expect(files).toHaveLength(fileCount);
      expect(files.some((file) => file.source.kind === "patch")).toBe(true);
      expect(files.some((file) => file.source.kind === "content")).toBe(true);
      expect(files.some((file) => file.oldPath !== undefined)).toBe(true);
      expect(files.some((file) => file.path.length > 80)).toBe(true);
      expect(files.some((file) => file.note !== undefined)).toBe(true);
      expect(
        files.some(
          (file) =>
            file.source.kind === "content" &&
            file.source.oldContent === file.source.newContent
        )
      ).toBe(true);
      expect(
        files.some(
          (file) =>
            file.source.kind === "patch" &&
            file.source.structuredPatch.length > 1
        )
      ).toBe(true);
    }
  );

  it("keeps fixture estimates within a calibrated range of realized diff geometry", () => {
    const files = flattenDiffFileFixture(createDiffFileFixture(120));
    const measurements = files.map((file) => {
      const estimate = estimateDiffFileCardSize(file, CALIBRATION_OPTIONS);
      const realized = realizedCardHeight(file);
      return { estimate, realized, delta: estimate - realized };
    });
    const meanDelta =
      measurements.reduce((sum, measurement) => sum + measurement.delta, 0) /
      measurements.length;
    const maxAbsoluteDelta = Math.max(
      ...measurements.map((measurement) => Math.abs(measurement.delta))
    );
    expect(Math.abs(meanDelta)).toBeLessThan(2);
    expect(maxAbsoluteDelta).toBeLessThan(40);
  });
});
