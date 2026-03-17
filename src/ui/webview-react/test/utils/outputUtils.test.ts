import { describe, it, expect } from "vitest";
import {
  shortenPath,
  formatTimeHMS,
  extractKeyParameters,
  parseUnifiedDiff,
  generateDiffLines,
  generateMarkdownExport,
} from "@utils/outputUtils";
import type { UnifiedDiffHunk } from "@/types/cliEvents";

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

// ─────────────────────────────────────────────────────────────────────────────
// extractKeyParameters
// ─────────────────────────────────────────────────────────────────────────────

describe("extractKeyParameters", () => {
  it("returns empty string with no parameters", () => {
    expect(extractKeyParameters("anyTool")).toBe("");
  });

  it("returns truncated command for bash tool", () => {
    const result = extractKeyParameters("bash", { command: "npm test --watch" });
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
    const result = extractKeyParameters("multiedit", { files: ["a.ts", "b.ts", "c.ts"] });
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
    const result = extractKeyParameters("grep", { pattern: "TODO", path: "src" });
    expect(result).toContain('"TODO"');
    expect(result).toContain("src");
  });

  it("returns description for task tool", () => {
    const result = extractKeyParameters("task", { description: "Do something useful" });
    expect(result).toContain("Do something");
  });

  it("returns key:value pairs for unknown tool", () => {
    const result = extractKeyParameters("customTool", { alpha: "one", beta: "two" });
    expect(result).toContain("alpha:");
    expect(result).toContain("beta:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseUnifiedDiff
// ─────────────────────────────────────────────────────────────────────────────

describe("parseUnifiedDiff", () => {
  const hunks: UnifiedDiffHunk[] = [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [" context line", "-removed line", "+added line"],
    },
  ];

  it("produces DiffLine entries for each hunk line", () => {
    const result = parseUnifiedDiff(hunks);
    expect(result).toHaveLength(3);
  });

  it("parses context lines correctly", () => {
    const result = parseUnifiedDiff(hunks);
    const context = result.find((l) => l.type === "context");
    expect(context?.content).toBe("context line");
    expect(context?.oldLineNum).toBe(1);
    expect(context?.newLineNum).toBe(1);
  });

  it("parses removed lines correctly", () => {
    const result = parseUnifiedDiff(hunks);
    const removed = result.find((l) => l.type === "removed");
    expect(removed?.content).toBe("removed line");
    expect(removed?.oldLineNum).toBe(2);
    expect(removed?.newLineNum).toBeUndefined();
  });

  it("parses added lines correctly", () => {
    const result = parseUnifiedDiff(hunks);
    const added = result.find((l) => l.type === "added");
    expect(added?.content).toBe("added line");
    expect(added?.newLineNum).toBe(2);
    expect(added?.oldLineNum).toBeUndefined();
  });

  it("increments line numbers across multiple hunks", () => {
    const twoHunks: UnifiedDiffHunk[] = [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+line A"] },
      { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: ["+line B"] },
    ];
    const result = parseUnifiedDiff(twoHunks);
    expect(result[0].newLineNum).toBe(1);
    expect(result[1].newLineNum).toBe(5);
  });

  it("returns empty array for empty hunks", () => {
    expect(parseUnifiedDiff([])).toEqual([]);
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
    expect(generateMarkdownExport([], metadata)).toContain("No output captured");
  });

  it("renders a status entry as a blockquote", () => {
    const outputs = [
      {
        type: "status" as const,
        stepIndex: 0,
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
        stepIndex: 0,
        timestamp: 2000,
        attemptIndex: 0,
        data: {
          prompt: "Analyze the codebase",
          response: "Here is my analysis...",
        },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("## Prompt 1 - Initial Attempt");
    expect(md).toContain("Analyze the codebase");
    expect(md).toContain("Here is my analysis...");
  });

  it("labels retries correctly", () => {
    const outputs = [
      {
        type: "cli" as const,
        stepIndex: 0,
        timestamp: 1000,
        attemptIndex: 2,
        data: { response: "retry response" },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("Retry 2");
  });

  it("renders token stats when present", () => {
    const outputs = [
      {
        type: "cli" as const,
        stepIndex: 0,
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
        stepIndex: 0,
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
      { type: "cli" as const, stepIndex: 1, timestamp: 3000, attemptIndex: 0, data: { response: "second" } },
      { type: "cli" as const, stepIndex: 0, timestamp: 1000, attemptIndex: 0, data: { response: "first" } },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    const firstIdx = md.indexOf("first");
    const secondIdx = md.indexOf("second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});
