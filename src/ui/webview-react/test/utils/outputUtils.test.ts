import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { REDACTION_MARKER } from "@root/types/PreviewRedactor";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { useSettingsStore } from "@store/settingsStore";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import {
  buildDiffAnchorPrefix,
  formatAttemptLabel,
  formatExecutionBadge,
  formatRunLabel,
  shortenPath,
  formatTimeHMS,
  extractKeyParameters,
  extractCliOutputText,
  generateDiffLines,
  normalizeStructuredPatch,
  isStructuredPatchMalformed,
  countStructuredPatchDisplayLines,
} from "@utils/outputUtils";
import { CLI_EVENT_TYPES } from "@/types/cliEvents";
import {
  generateMarkdownExport,
  generateSingleStepMarkdownExport,
} from "@utils/markdownExport";
import type { UnifiedDiffHunk } from "@/types/cliEvents";
import {
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  SCRIPT_OUTPUT_SOURCES,
} from "@/types/messages";
import { hasRenderableDiff } from "@utils/diffUtils";

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
// extractCliOutputText
// ─────────────────────────────────────────────────────────────────────────────

describe("extractCliOutputText", () => {
  it("returns plain assistant text from structured events", () => {
    expect(
      extractCliOutputText({
        structured: {
          events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "hello" } }],
          metadata: {},
        },
        elapsed: 0,
        isStreaming: false,
      })
    ).toBe("hello");
  });

  it("copies assistant TEXT events while ignoring non-text events", () => {
    const output = {
      isStreaming: false,
      elapsed: 0,
      structured: {
        events: [
          { type: CLI_EVENT_TYPES.TEXT, data: { text: "before." } },
          { type: CLI_EVENT_TYPES.FOLLOW_UP_RESUMED, data: { resumedAt: 1 } },
          { type: CLI_EVENT_TYPES.TEXT, data: { text: " and after." } },
        ],
        metadata: {},
      },
    };
    expect(extractCliOutputText(output)).toBe("before.\n\n and after.");
  });

  it("joins structured TEXT around follow-up events", () => {
    const output = {
      isStreaming: false,
      elapsed: 0,
      structured: {
        events: [
          { type: CLI_EVENT_TYPES.TEXT, data: { text: "base" } },
          { type: CLI_EVENT_TYPES.FOLLOW_UP_RESUMED, data: { resumedAt: 1 } },
          { type: CLI_EVENT_TYPES.TEXT, data: { text: "+resumed" } },
        ],
        metadata: {},
      },
    };
    expect(extractCliOutputText(output)).toBe("base\n\n+resumed");
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
    expect(buildDiffAnchorPrefix("q", 3, 2, 1)).toBe("cy-diff-q-3-r2-a1");
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
  it("treats an empty old content string as a renderable diff", () => {
    expect(hasRenderableDiff({ oldContent: "", newContent: "new" })).toBe(true);
  });

  it("rejects a source with no diff data", () => {
    expect(hasRenderableDiff({})).toBe(false);
  });

  it("accepts a non-empty structured patch", () => {
    expect(
      hasRenderableDiff({
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: ["+new"],
          },
        ],
      })
    ).toBe(true);
  });

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

  it("drops invalid patch lines and recomputes hunk counts", () => {
    const [normalized] = normalizeStructuredPatch([
      {
        oldStart: 4,
        oldLines: 99,
        newStart: 4,
        newLines: 99,
        lines: [
          "-before",
          "unprefixed persisted data",
          "+after",
          "\\ No newline at end of file",
        ],
      },
    ]);

    expect(normalized).toEqual({
      oldStart: 4,
      oldLines: 1,
      newStart: 4,
      newLines: 1,
      lines: ["-before", "+after", "\\ No newline at end of file"],
    });
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
    fileName: "my-workflow.ctrlyoke.yaml",
    executionState: "completed",
    currentStep: 2,
    totalSteps: 2,
  };

  it("includes the header and metadata", () => {
    const md = generateMarkdownExport([], metadata);
    expect(md).toContain("# ctrlyoke Execution Output");
    expect(md).toContain("my-workflow.ctrlyoke.yaml");
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

  it("renders the structured assistant response", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 2000,
        attemptIndex: 0,
        data: {
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.TEXT,
                data: { text: "Here is my analysis..." },
              },
            ],
            metadata: {},
          },
        },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("## Step 1 — Initial Attempt");
    expect(md).toContain("Here is my analysis...");
  });

  it("uses fences longer than backtick runs in assistant and bash output", () => {
    const response = "```js\nconsole.log('nested')\n```\n````txt\ninner\n````";
    const bashOutput = "```sh\necho nested\n```";
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 2000,
        attemptIndex: 0,
        data: {
          structured: {
            events: [
              { type: CLI_EVENT_TYPES.TEXT, data: { text: response } },
              {
                type: CLI_EVENT_TYPES.BASH_COMMAND,
                data: {
                  command: "cat output",
                  status: "completed",
                  output: bashOutput,
                },
              },
            ],
          },
        },
      },
    ];

    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain(response);
    expect(md).toContain(bashOutput);
  });

  it("labels retries correctly", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 2,
        data: { structured: { events: [], metadata: {} } },
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
        data: { structured: { events: [], metadata: {} } },
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

  it.each([1_000_000, 999_960])(
    "formats a %i-token context window using the shared token units",
    (contextWindowUsed) => {
      const outputs = [
        {
          type: "cli" as const,
          target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
          timestamp: 1000,
          attemptIndex: 0,
          data: {
            tokens: {
              prompt: 0,
              completion: 0,
              contextWindowUsed,
              contextWindowSize: 1_000_000,
            },
          },
        },
      ];

      const md = generateMarkdownExport(outputs, metadata);
      expect(md).toContain("Context: 1M/1M (100%)");
    }
  );

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
    expect(md).toContain("``` bash");
    expect(md).toContain("/workspace> claude --model sonnet");
  });

  it("renders MCP tool parameters and results in structured output", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: {
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
                data: {
                  server: "queue",
                  tool: "append",
                  parameters: { prompt: "mcp parameter output" },
                  result: { success: true, output: "mcp result output" },
                },
              },
            ],
            metadata: {},
          },
        },
      },
    ];

    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("● MCP: queue.append(prompt: mcp parameter output)");
    expect(md).toContain("⎿  mcp result output");
  });

  it("exports file writes, answered questions, steers, search results, and terminal tails", () => {
    const output = {
      elapsed: 1,
      isStreaming: false,
      structured: {
        events: [
          {
            type: CLI_EVENT_TYPES.FILE_WRITE,
            data: {
              path: "src/new.ts",
              content: "export const value = 1;",
              status: "completed",
            },
          },
          {
            type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
            data: {
              questions: [{ question: "Ship it?", options: [], answer: "Yes" }],
            },
          },
          {
            type: CLI_EVENT_TYPES.USER_STEER,
            data: { text: "Please add a test" },
          },
          {
            type: CLI_EVENT_TYPES.WEB_SEARCH,
            data: {
              query: "docs",
              results: [{ title: "Guide", url: "https://example.test/guide" }],
            },
          },
          {
            type: CLI_EVENT_TYPES.TERMINAL_OUTPUT,
            data: { reason: "process-exit", text: "last terminal line" },
          },
        ],
      },
    };
    const md = generateMarkdownExport(
      [
        {
          type: "cli",
          target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
          timestamp: 1,
          data: output,
        },
      ],
      metadata
    );

    expect(md).toContain("+export const value = 1;");
    expect(md).toContain("Answer: Yes");
    expect(md).toContain("User steer: Please add a test");
    expect(md).toContain("[Guide](https://example.test/guide)");
    expect(md).toContain("last terminal line");
  });

  it("projects every remaining structured event kind or handles it as a marker", () => {
    const output = {
      elapsed: 1,
      isStreaming: false,
      structured: {
        events: [
          {
            type: CLI_EVENT_TYPES.FILE_READ,
            data: { path: "src/read.ts", status: "completed" },
          },
          {
            type: CLI_EVENT_TYPES.FILE_DELETE,
            data: { path: "src/removed.ts" },
          },
          {
            type: CLI_EVENT_TYPES.TOOL_CALL,
            data: {
              name: "lookup",
              parameters: { key: "value" },
              result: { success: true, output: "lookup result" },
            },
          },
          {
            type: CLI_EVENT_TYPES.THINKING,
            data: { text: "reasoning text", label: "Reasoning" },
          },
          {
            type: CLI_EVENT_TYPES.TOOL_RESULT,
            data: {
              toolCallId: "tool-1",
              result: { success: true, output: "standalone result" },
            },
          },
          { type: CLI_EVENT_TYPES.COMPACTION, data: { trigger: "automatic" } },
          { type: CLI_EVENT_TYPES.FOLLOW_UP_RESUMED, data: { resumedAt: 1 } },
          {
            type: CLI_EVENT_TYPES.BACKGROUND_WORK_HOLD,
            data: { heldAt: 1, pendingTasks: [], awaitingResumedTurn: true },
          },
          {
            type: CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC,
            data: { used: 1, size: 100 },
          },
        ],
      },
    };
    const md = generateMarkdownExport(
      [
        {
          type: "cli",
          target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
          timestamp: 1,
          data: output,
        },
      ],
      metadata
    );

    expect(md).toContain("Read src/read.ts");
    expect(md).toContain("Delete file: src/removed.ts");
    expect(md).toContain("lookup result");
    expect(md).toContain("Reasoning: reasoning text");
    expect(md).toContain("standalone result");
  });

  it("copies the same full single-step markdown as a one-step export", () => {
    const output = {
      elapsed: 1,
      isStreaming: false,
      structured: {
        events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "answer" } }],
      },
    };
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 2 };
    const expected = generateMarkdownExport(
      [{ type: "cli", target, timestamp: 1, data: output }],
      metadata,
      { exportOptions: { stepRange: [1], includeMetadata: false } }
    );
    expect(generateSingleStepMarkdownExport(output as any, target)).toBe(
      expected
    );
  });

  it("exports typed script output when structured CLI events are absent", () => {
    const md = generateMarkdownExport(
      [
        {
          type: "cli",
          target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
          timestamp: 1,
          data: {
            scriptOutput: {
              command: "npm run check",
              stdout: "script stdout",
              stderr: "script stderr",
            },
          },
        },
      ],
      metadata
    );
    expect(md).toContain("script stdout\nscript stderr");
  });

  it("exports normalized patch hunks without numbering no-newline markers", () => {
    const hunk: UnifiedDiffHunk = {
      oldStart: 10,
      oldLines: 1,
      newStart: 10,
      newLines: 2,
      lines: [
        "-old last",
        "\\ No newline at end of file",
        "+new last",
        "+another",
        "\\ No newline at end of file",
      ],
    };
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: {
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/example.ts",
                  status: "completed",
                  structuredPatch: [hunk, hunk],
                },
              },
            ],
          },
        },
      },
    ];

    const md = generateMarkdownExport(outputs, metadata);

    expect(md).toContain("-  10 | old last");
    expect(md).toContain("+  10 | new last");
    expect(md).toContain("+  11 | another");
    expect(md).not.toContain("No newline at end of file");
    expect(md.match(/\+\s+10 \| new last/g)).toHaveLength(1);
  });

  it("does not export script prompts and keeps script commands when command export is disabled", () => {
    for (const source of Object.values(SCRIPT_OUTPUT_SOURCES)) {
      const md = generateMarkdownExport(
        [
          {
            type: "cli" as const,
            target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
            timestamp: 1000,
            attemptIndex: 0,
            data: {
              prompt: "npm test",
              cliCommand: "npm test",
              workingDirectory: "/workspace",
              source,
            },
          },
        ],
        metadata,
        { exportOptions: { includeCommand: false } }
      );

      expect(md).not.toContain("### Prompt");
      expect(md).toContain("/workspace> npm test");
    }
  });

  it("renders injected prompts in the command section using the injected text", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: {
          cliCommand: "Open the referenced file and summarize it.",
          cliCommandWasInjected: true,
        },
      },
    ];

    const md = generateMarkdownExport(outputs, metadata);
    expect(md).toContain("Prompt was injected into running terminal:");
    expect(md).toContain("Open the referenced file and summarize it.");
    expect(md).not.toContain("```bash");
  });

  it("sorts outputs chronologically when out of order", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
        timestamp: 3000,
        attemptIndex: 0,
        data: {
          structured: {
            events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "second" } }],
            metadata: {},
          },
        },
      },
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: {
          structured: {
            events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "first" } }],
            metadata: {},
          },
        },
      },
    ];
    const md = generateMarkdownExport(outputs, metadata);
    const firstIdx = md.indexOf("first");
    const secondIdx = md.indexOf("second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("keeps CLI output before a later status message for the same step", () => {
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
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.TEXT,
                data: { text: "error: unknown option '--poopy'" },
              },
            ],
            metadata: {},
          },
        },
      },
    ];

    const md = generateMarkdownExport(outputs, metadata);
    const cliIdx = md.indexOf("## Step 1 — Initial Attempt");
    const statusIdx = md.indexOf(
      "Process exited unexpectedly — workflow stopped"
    );
    expect(cliIdx).toBeLessThan(statusIdx);
  });

  it("orders equal-timestamp items by sequence and labels final-step passes", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.FINAL_STEP, index: 0 },
        timestamp: 1000,
        sequence: 2,
        attemptIndex: 0,
        data: {
          structured: {
            events: [
              { type: CLI_EVENT_TYPES.TEXT, data: { text: "final response" } },
            ],
            metadata: {},
          },
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
      md.indexOf("## Final Step Pass 1 — Initial Attempt")
    );
    expect(md).toContain("## Final Step Pass 1 — Initial Attempt");
  });

  it("prefers canonical ordered entries when provided for export", () => {
    const outputs = [
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
        timestamp: 3000,
        attemptIndex: 0,
        data: {
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.TEXT,
                data: { text: "legacy queue second" },
              },
            ],
            metadata: {},
          },
        },
      },
      {
        type: "cli" as const,
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        data: {
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.TEXT,
                data: { text: "legacy queue first" },
              },
            ],
            metadata: {},
          },
        },
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
          structured: {
            events: [{ type: "text", data: { text: "canonical final" } }],
            metadata: {},
          },
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
      md.indexOf("## Final Step Pass 1 — Initial Attempt")
    );
    expect(md).toContain("canonical final");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateMarkdownExport — secret redaction
// ─────────────────────────────────────────────────────────────────────────────

describe("generateMarkdownExport redaction", () => {
  const metadata = {
    fileName: "my-workflow.ctrlyoke.yaml",
    executionState: "completed",
    currentStep: 1,
    totalSteps: 1,
  };

  const outputsWithSecret = [
    {
      type: "cli" as const,
      target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
      timestamp: 1000,
      attemptIndex: 0,
      data: {
        structured: {
          events: [
            {
              type: CLI_EVENT_TYPES.TEXT,
              data: { text: "export API_TOKEN=abcdef0123456789" },
            },
          ],
          metadata: {},
        },
      },
    },
  ];

  beforeEach(() => {
    useSettingsStore.setState({ fullGlobalSettings: null });
  });

  afterEach(() => {
    useSettingsStore.setState({ fullGlobalSettings: null });
  });

  // Regression guard: this used to route through the process-wide redaction
  // singleton in src/utils, whose transitive `os.homedir()` import blanked the
  // whole dashboard once Vite stubbed it out for the browser.
  it("applies heuristic redaction by default", () => {
    const md = generateMarkdownExport(outputsWithSecret, metadata);
    expect(md).toContain(REDACTION_MARKER);
    expect(md).not.toContain("abcdef0123456789");
  });

  it("skips heuristic redaction when the setting is disabled", () => {
    useSettingsStore.setState({
      fullGlobalSettings: {
        settings: {
          ...CTRLYOKE_SETTINGS_DEFAULTS,
          permissions: {
            ...CTRLYOKE_SETTINGS_DEFAULTS.permissions,
            heuristicSecretRedactionEnabled: false,
          },
        },
        sources: {},
      } as FullGlobalSettings,
    });
    const md = generateMarkdownExport(outputsWithSecret, metadata);
    expect(md).toContain("abcdef0123456789");
    expect(md).not.toContain(REDACTION_MARKER);
  });
});
