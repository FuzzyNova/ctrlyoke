import { describe, it, expect } from "vitest";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import {
  buildDiffAnchorPrefix,
  formatAttemptLabel,
  formatExecutionBadge,
  formatRunLabel,
  shortenPath,
  formatTimeHMS,
  extractKeyParameters,
  generateDiffLines,
  normalizeStructuredPatch,
  isStructuredPatchMalformed,
  countStructuredPatchDisplayLines,
} from "@utils/outputUtils";
import { generateMarkdownExport } from "@utils/markdownExport";
import type { UnifiedDiffHunk } from "@/types/cliEvents";
import { FINAL_STEP_PHASES, OUTPUT_HISTORY_KINDS } from "@/types/messages";

// ─────────────────────────────────────────────────────────────────────────────
// shortenPath
// ─────────────────────────────────────────────────────────────────────────────

describe("shortenPath", () => {
  it("returns the path unchanged when shorter than maxLen", () => {
    expect(shortenPath("src/foo.ts", 50)).toBe("src/foo.ts");
  });

  it("returns empty string for undefined", () => {
    expect(shortenPath(undefined)).toBe("");
  });

  it("shortens long paths to ...parent/file.ext", () => {
    const long = "a/b/c/d/e/f/g/reallyLongSegment/deep/file.ts";
    const result = shortenPath(long, 20);
    expect(result).toBe("...deep/file.ts");
  });

  it("does not shorten if only 2 path segments", () => {
    const path = "parent/file.ts"; // 14 chars, less than default 50
    expect(shortenPath(path, 10)).toBe(path); // can't shorten a 2-segment path
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatTimeHMS
// ─────────────────────────────────────────────────────────────────────────────

describe("formatTimeHMS", () => {
  it("formats a timestamp as HH:MM:SS", () => {
    // Use a fixed time: 2024-01-01T13:05:09 UTC
    // We can't control locale, so just check the format HH:MM:SS
    const ts = new Date("2024-01-01T13:05:09.000Z").getTime();
    const result = formatTimeHMS(ts);
    // Should match ##:##:## pattern
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("run and retry labels", () => {
  it("formats rerun labels only for manual reruns", () => {
    expect(formatRunLabel(0)).toBe("");
    expect(formatRunLabel(2)).toBe("Re-run 2");
  });

  it("formats retry labels and optional initial-attempt labels", () => {
    expect(formatAttemptLabel(0)).toBe("");
    expect(formatAttemptLabel(0, true)).toBe("Initial Attempt");
    expect(formatAttemptLabel(3)).toBe("Retry 3");
  });

  it("combines run and retry labels into a single execution badge", () => {
    expect(formatExecutionBadge(0, 0, true)).toBe("Initial Attempt");
    expect(formatExecutionBadge(1, 0, true)).toBe("Re-run 1 · Initial Attempt");
    expect(formatExecutionBadge(2, 1)).toBe("Re-run 2 · Retry 1");
  });

  it("builds diff anchor prefixes with runIndex and attemptIndex", () => {
    expect(buildDiffAnchorPrefix("q", 3, 2, 1)).toBe("fp-diff-q-3-r2-a1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractKeyParameters
// ─────────────────────────────────────────────────────────────────────────────

describe("extractKeyParameters", () => {
  it("returns empty string with no parameters", () => {
    expect(extractKeyParameters("anyTool")).toBe("");
  });

  it("returns truncated command for bash tool", () => {
    const result = extractKeyParameters("bash", {
      command: "npm test --watch",
    });
    expect(result).toContain("npm test");
  });

  it("returns truncated command for shell tool (case-insensitive)", () => {
    const result = extractKeyParameters("Shell", { command: "ls -la" });
    expect(result).toContain("ls -la");
  });

  it("returns shortened path for write tool", () => {
    const result = extractKeyParameters("write", { file_path: "src/foo.ts" });
    expect(result).toContain("foo.ts");
  });

  it("returns shortened path for edit tool", () => {
    const result = extractKeyParameters("edit", { file_path: "src/bar.ts" });
    expect(result).toContain("bar.ts");
  });

  it("returns count for multiedit with multiple files", () => {
    const result = extractKeyParameters("multiedit", {
      files: ["a.ts", "b.ts", "c.ts"],
    });
    expect(result).toBe("3 files");
  });

  it("returns '1 file' for multiedit with a single file", () => {
    const result = extractKeyParameters("multiedit", { files: ["a.ts"] });
    expect(result).toBe("1 file");
  });

  it("returns pattern for glob tool", () => {
    const result = extractKeyParameters("glob", { pattern: "**/*.ts" });
    expect(result).toBe("**/*.ts");
  });

  it("returns pattern + path for grep tool", () => {
    const result = extractKeyParameters("grep", {
      pattern: "TODO",
      path: "src",
    });
    expect(result).toContain('"TODO"');
    expect(result).toContain("src");
  });

  it("returns description for task tool", () => {
    const result = extractKeyParameters("task", {
      description: "Do something useful",
    });
    expect(result).toContain("Do something");
  });

  it("returns key:value pairs for unknown tool", () => {
    const result = extractKeyParameters("customTool", {
      alpha: "one",
      beta: "two",
    });
    expect(result).toContain("alpha:");
    expect(result).toContain("beta:");
  });
});

describe("structured patch helpers", () => {
  it("removes exact duplicate hunks while preserving order", () => {
    const hunk: UnifiedDiffHunk = {
      oldStart: 5,
      oldLines: 1,
      newStart: 5,
      newLines: 1,
      lines: ["-before", "+after"],
    };

    expect(normalizeStructuredPatch([hunk, hunk])).toEqual([hunk]);
  });

  it("flags out-of-order hunk sequences as malformed", () => {
    const malformedPatch: UnifiedDiffHunk[] = [
      {
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1,
        lines: ["-late", "+later"],
      },
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-early", "+earlier"],
      },
    ];

    expect(isStructuredPatchMalformed(malformedPatch)).toBe(true);
  });

  it("counts only displayable diff lines", () => {
    const patch: UnifiedDiffHunk[] = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          "-before",
          "+after",
          "\\ No newline at end of file",
          "@@ skipped metadata @@",
        ],
      },
    ];

    expect(countStructuredPatchDisplayLines(patch)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateDiffLines
// ─────────────────────────────────────────────────────────────────────────────

describe("generateDiffLines", () => {
  it("returns no lines for identical content", () => {
    const result = generateDiffLines("same\n", "same\n");
    const changed = result.filter((l) => l.type !== "context");
    expect(changed).toHaveLength(0);
  });

  it("produces added lines for new content", () => {
    const result = generateDiffLines("line1\n", "line1\nline2\n");
    const added = result.filter((l) => l.type === "added");
    expect(added.length).toBeGreaterThan(0);
    expect(added[0].content).toBe("line2");
  });

  it("produces removed lines for deleted content", () => {
    const result = generateDiffLines("line1\nline2\n", "line1\n");
    const removed = result.filter((l) => l.type === "removed");
    expect(removed.length).toBeGreaterThan(0);
    expect(removed[0].content).toBe("line2");
  });

  it("assigns sequential line numbers to added lines", () => {
    const result = generateDiffLines("a\n", "a\nb\nc\n");
    const added = result.filter((l) => l.type === "added");
    expect(added[0].newLineNum).toBe(2);
    expect(added[1].newLineNum).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateMarkdownExport
// ─────────────────────────────────────────────────────────────────────────────

describe("generateMarkdownExport", () => {
  const metadata = {
    fileName: "my-workflow.flightpath.yaml",
    executionState: "completed",
    currentStep: 2,
    totalSteps: 2,
  };

  it("includes the header and metadata", () => {
    const md = generateMarkdownExport([], metadata);
    expect(md).toContain("# FlightPath Execution Output");
    expect(md).toContain("my-workflow.flightpath.yaml");
    expect(md).toContain("completed");
    expect(md).toContain("2 of 2");
  });

  it("shows 'No output captured' for empty outputs", () => {
    expect(generateMarkdownExport([], metadata)).toContain(
      "No output captured"
    );
  });

  it("renders a status entry as a blockquote", () => {
    const outputs = [
      {
        type: "status" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        data: { message: "Workflow started", timestamp: "10:00:00" },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("> **[10:00:00]** Workflow started");
  });

  it("renders a CLI entry with prompt section", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 2000,
        attemptIndex: 0,
        data: {
          prompt: "Analyze the codebase",
          response: "Here is my analysis...",
        },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("## Step 1: Analyze the codebase — Initial Attempt");
    expect(md).toContain("Analyze the codebase");
    expect(md).toContain("Here is my analysis...");
  });

  it("labels retries correctly", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 2,
        data: { response: "retry response" },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("Retry 2");
  });

  it("labels manual reruns independently from retries", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 1,
        data: { response: "rerun response" },
      },
    ];

    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("Re-run 1 · Initial Attempt");
  });

  it("renders token stats when present", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: {
          tokens: { prompt: 100, completion: 50, cached: 20 },
          elapsed: 3.5,
        },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("100 in / 50 out / 150 total");
    expect(md).toContain("20 cached");
    expect(md).toContain("3.5s");
  });

  it("renders CLI command block when present", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: {
          cliCommand: "claude --model sonnet",
          workingDirectory: "/workspace",
        },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("```bash");
    expect(md).toContain("/workspace> claude --model sonnet");
  });

  it("sorts outputs chronologically when out of order", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
        timestamp: 3000,
        attemptIndex: 0,
        data: { response: "second" },
      },
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: { response: "first" },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    const firstIdx = md.indexOf("first");
    const secondIdx = md.indexOf("second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("keeps prompt output before a later status message for the same step", () => {
    const outputs = [
      {
        type: "status" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 2000,
        data: {
          message: "Process exited unexpectedly — workflow stopped",
          timestamp: "10:00:02",
        },
      },
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: {
          prompt: "just say hi",
          response: "error: unknown option '--poopy'",
        },
      },
    ];

    const md = generateMarkdownExport(outputs, metadata);
    const promptIdx = md.indexOf("## Step 1: just say hi — Initial Attempt");
    const statusIdx = md.indexOf(
      "Process exited unexpectedly — workflow stopped"
    );
    expect(promptIdx).toBeLessThan(statusIdx);
  });

  it("orders equal-timestamp items by sequence and labels final step loops", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.FINAL_STEP, index: 0 },
        timestamp: 1000,
        sequence: 2,
        attemptIndex: 0,
        data: {
          response: "final response",
        },
      },
      {
        type: "status" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        sequence: 1,
        data: {
          message: "queued first",
          timestamp: "10:00:00",
        },
      },
    ];

    const md = generateMarkdownExport(outputs, metadata);
    expect(md.indexOf("queued first")).toBeLessThan(
      md.indexOf("## Final Step Loop 1 — Initial Attempt")
    );
    expect(md).toContain("## Final Step Loop 1 — Initial Attempt");
  });

  it("prefers canonical ordered entries when provided for export", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
        timestamp: 3000,
        attemptIndex: 0,
        data: { response: "legacy queue second" },
      },
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: { response: "legacy queue first" },
      },
    ];
    const orderedEntries: OrderedHistoryEntry[] = [
      {
        kind: OUTPUT_HISTORY_KINDS.STATUS,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        statusMessage: {
          message: "canonical status",
          severity: "info",
          timestamp: 1000,
        },
        timestampMs: 1000,
        sequence: 1,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
        attemptIndex: 0,
        cliOutput: {
          prompt: "",
          response: "canonical final",
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 2,
      },
    ];

    const md = generateMarkdownExport(outputs, metadata, { orderedEntries });
    expect(md.indexOf("canonical status")).toBeLessThan(
      md.indexOf("## Final Step Loop 1 — Initial Attempt")
    );
    expect(md).toContain("canonical final");
  });
});
