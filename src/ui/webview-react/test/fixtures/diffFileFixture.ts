import type { DiffFileCardProps } from "@components/diff/DiffFileCard";
import type { DiffFileGroup } from "@components/diff/DiffFileList";
import type { UnifiedDiffHunk } from "@root/types/CliOutputTypes";
import {
  DIFF_FILE_SOURCE_KINDS,
  WORKSPACE_ENTRY_KINDS,
} from "@root/types/DashboardConstants";

/** The sizes used by the deterministic virtualization acceptance tests. */
export const DIFF_FILE_FIXTURE_SIZES = [60, 120, 240] as const;

const GROUPS = [
  { key: "fixture-structured", heading: "Structured patches" },
  { key: "fixture-content", heading: "Full-content changes" },
  { key: "fixture-context", heading: "Context-heavy changes" },
] as const;

const WRAPPED_NOTE =
  "Generated fixture note: this deliberately wraps across the available card width " +
  "to exercise measured header chrome and row replacement.";

function lines(count: number, prefix: string): string {
  return Array.from(
    { length: count },
    (_unused, line) => `${prefix} line ${line + 1}`
  ).join("\n");
}

function smallStructuredPatch(index: number): UnifiedDiffHunk[] {
  return [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        ` fixture-file-${index}-marker`,
        `-const before${index} = false;`,
        `+const after${index} = true;`,
      ],
    },
  ];
}

function wideGapPatch(index: number): UnifiedDiffHunk[] {
  return [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        ` fixture-file-${index}-marker-start`,
        `-const start${index} = "old";`,
        `+const start${index} = "new";`,
      ],
    },
    {
      oldStart: 132,
      oldLines: 3,
      newStart: 132,
      newLines: 3,
      lines: [
        ` fixture-file-${index}-marker-end`,
        `-return end${index}();`,
        `+return nextEnd${index}();`,
      ],
    },
  ];
}

function fixtureFile(index: number): DiffFileCardProps & { key: string } {
  const basename = `fixture-${index}.ts`;
  const marker = `fixture-file-${index}-marker`;
  const longPath =
    index % 11 === 0
      ? `packages/very-long-feature-area/${"nested/".repeat(8)}${basename}`
      : `src/fixture/${basename}`;
  const renamed = index % 13 === 0;
  const note = index % 7 === 0 ? WRAPPED_NOTE : undefined;
  const kind = index % 6;

  let source: DiffFileCardProps["source"];
  let changeType: DiffFileCardProps["changeType"] = "modified";

  switch (kind) {
    case 0:
      source = {
        kind: DIFF_FILE_SOURCE_KINDS.PATCH,
        structuredPatch: smallStructuredPatch(index),
        oldContent: `${marker}\nconst before${index} = false;`,
      };
      break;
    case 1:
      source = {
        kind: WORKSPACE_ENTRY_KINDS.CONTENT,
        oldContent: lines(320, `raw-old-${marker}`),
        newContent: lines(320, `raw-new-${marker}`),
      };
      break;
    case 2:
      source = {
        kind: DIFF_FILE_SOURCE_KINDS.PATCH,
        structuredPatch: wideGapPatch(index),
        oldContent: lines(180, `wide-gap-${marker}`),
      };
      break;
    case 3:
      source = {
        kind: WORKSPACE_ENTRY_KINDS.CONTENT,
        oldContent: `rename-old-${marker}\nexport const value = "before";\n`,
        newContent: `rename-new-${marker}\nexport const value = "after";\n`,
      };
      changeType = "renamed";
      break;
    case 4:
      source = {
        kind: WORKSPACE_ENTRY_KINDS.CONTENT,
        oldContent: `${marker}\nconst value = 1;\n`,
        newContent: `${marker}\nconst value = 1;\n`,
      };
      break;
    default:
      source = {
        kind: DIFF_FILE_SOURCE_KINDS.PATCH,
        structuredPatch: [
          {
            oldStart: 20,
            oldLines: 4,
            newStart: 20,
            newLines: 5,
            lines: [
              ` ${marker}`,
              ` context-stable-${marker}`,
              `-const oldValue${index} = 1;`,
              `+const newValue${index} = 2;`,
              ` context-after-${marker}`,
            ],
          },
        ],
      };
      break;
  }

  return {
    key: `fixture-${index}`,
    path: longPath,
    ...(renamed ? { oldPath: `src/legacy/${basename}` } : {}),
    changeType,
    source,
    language: "typescript",
    ...(note ? { note } : {}),
  };
}

/**
 * Build a stable, deliberately varied diff model for profiling and tests.
 * The same index always produces the same source identity and content, so
 * callers can compare 60, 120, and 240 files without changing the viewport.
 */
export function createDiffFileFixture(fileCount: number): DiffFileGroup[] {
  if (!Number.isInteger(fileCount) || fileCount < 0) {
    throw new RangeError("fileCount must be a non-negative integer");
  }

  const files = Array.from({ length: fileCount }, (_unused, index) =>
    fixtureFile(index)
  );
  const groups = GROUPS.map((group) => ({
    ...group,
    files: [] as Array<DiffFileCardProps & { key: string }>,
  }));

  files.forEach((file, index) => {
    groups[index % groups.length]!.files.push(file);
  });

  return groups.filter((group) => group.files.length > 0);
}

export function flattenDiffFileFixture(
  groups: DiffFileGroup[]
): Array<DiffFileCardProps & { key: string }> {
  return groups.flatMap((group) => group.files);
}
