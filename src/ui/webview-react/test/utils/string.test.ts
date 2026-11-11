import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  truncate,
  truncateSnippet,
  truncateNormalized,
  pluralize,
  getWorkflowName,
  capitalize,
  toTitleCase,
} from "@utils/string";
import { DEFAULT_WORKFLOW_NAME } from "@root/types/DashboardConstants";

describe("escapeHtml", () => {
  it("escapes < and > characters", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes script tags to prevent XSS", () => {
    const result = escapeHtml('<script>alert("xss")</script>');
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });
});

describe("truncate", () => {
  it("returns string unchanged when shorter than maxLen", () => {
    expect(truncate("Hi", 10)).toBe("Hi");
  });

  it("returns string unchanged when equal to maxLen", () => {
    expect(truncate("Hello", 5)).toBe("Hello");
  });

  it("truncates and appends ellipsis when over maxLen", () => {
    expect(truncate("Hello World", 8)).toBe("Hello Wo...");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("truncateSnippet", () => {
  it("normalizes whitespace and truncates with the default suffix", () => {
    expect(
      truncateSnippet(
        "  A   snippet\nwith\tmultiple   whitespace characters that is long enough to truncate in the results list  "
      )
    ).toBe(
      "A snippet with multiple whitespace characters that is long enough to truncate i..."
    );
  });

  it("returns normalized text unchanged when it fits", () => {
    expect(truncateSnippet("  A\n short   snippet  ")).toBe("A short snippet");
  });
});

describe("truncateNormalized", () => {
  it("collapses and trims whitespace", () => {
    expect(truncateNormalized("  one\n  two\tthree  ", 20)).toBe(
      "one two three"
    );
  });

  it("returns normalized text unchanged at the exact limit", () => {
    expect(truncateNormalized("  abc  ", 3)).toBe("abc");
  });

  it("truncates over-length text and appends three dots", () => {
    expect(truncateNormalized("abcdef", 3)).toBe("abc...");
  });

  it("handles empty input", () => {
    expect(truncateNormalized("", 3)).toBe("");
  });
});

describe("pluralize", () => {
  it("adds a plural suffix for zero and multiple items", () => {
    expect(pluralize(0, "question")).toBe("0 questions");
    expect(pluralize(2, "question")).toBe("2 questions");
  });

  it("keeps the noun singular for one", () => {
    expect(pluralize(1, "question")).toBe("1 question");
  });
});

describe("getWorkflowName", () => {
  it("returns DEFAULT_WORKFLOW_NAME for null", () => {
    expect(getWorkflowName(null)).toBe(DEFAULT_WORKFLOW_NAME);
  });

  it("returns DEFAULT_WORKFLOW_NAME for undefined", () => {
    expect(getWorkflowName(undefined)).toBe(DEFAULT_WORKFLOW_NAME);
  });

  it("returns DEFAULT_WORKFLOW_NAME for empty string", () => {
    expect(getWorkflowName("")).toBe(DEFAULT_WORKFLOW_NAME);
  });

  it("strips .ctrlyoke.yaml extension", () => {
    expect(getWorkflowName("/path/to/my-workflow.ctrlyoke.yaml")).toBe(
      "my-workflow"
    );
  });

  it("strips .ctrlyoke.json extension", () => {
    expect(getWorkflowName("/path/to/feature.ctrlyoke.json")).toBe("feature");
  });

  it("strips .ctrlyoke.yml extension", () => {
    expect(getWorkflowName("/path/to/task.ctrlyoke.yml")).toBe("task");
  });

  it("strips .prompt.md extension", () => {
    expect(getWorkflowName("/path/prompt.prompt.md")).toBe("prompt");
  });

  it("handles Windows backslash separators", () => {
    expect(getWorkflowName("C:\\Users\\dev\\feature.ctrlyoke.json")).toBe(
      "feature"
    );
  });
});

describe("capitalize", () => {
  it("capitalizes first letter", () => {
    expect(capitalize("hello")).toBe("Hello");
  });

  it("leaves already-capitalized strings unchanged", () => {
    expect(capitalize("Hello")).toBe("Hello");
  });

  it("handles empty string", () => {
    expect(capitalize("")).toBe("");
  });

  it("handles single character", () => {
    expect(capitalize("a")).toBe("A");
  });
});

describe("toTitleCase", () => {
  it("converts kebab-case to Title Case", () => {
    expect(toTitleCase("copilot-cli")).toBe("Copilot Cli");
  });

  it("converts snake_case to Title Case", () => {
    expect(toTitleCase("claude_code")).toBe("Claude Code");
  });

  it("handles single word", () => {
    expect(toTitleCase("hello")).toBe("Hello");
  });

  it("handles multiple segments", () => {
    expect(toTitleCase("foo-bar-baz")).toBe("Foo Bar Baz");
  });
});
