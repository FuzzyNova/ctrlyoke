import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  truncate,
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

describe("getWorkflowName", () => {
  it('returns DEFAULT_WORKFLOW_NAME for null', () => {
    expect(getWorkflowName(null)).toBe(DEFAULT_WORKFLOW_NAME);
  });

  it('returns DEFAULT_WORKFLOW_NAME for undefined', () => {
    expect(getWorkflowName(undefined)).toBe(DEFAULT_WORKFLOW_NAME);
  });

  it('returns DEFAULT_WORKFLOW_NAME for empty string', () => {
    expect(getWorkflowName("")).toBe(DEFAULT_WORKFLOW_NAME);
  });

  it("strips .flightpath.yaml extension", () => {
    expect(getWorkflowName("/path/to/my-workflow.flightpath.yaml")).toBe("my-workflow");
  });

  it("strips .flightpath.json extension", () => {
    expect(getWorkflowName("/path/to/feature.flightpath.json")).toBe("feature");
  });

  it("strips .flightpath.yml extension", () => {
    expect(getWorkflowName("/path/to/task.flightpath.yml")).toBe("task");
  });

  it("strips .prompt.md extension", () => {
    expect(getWorkflowName("/path/prompt.prompt.md")).toBe("prompt");
  });

  it("handles Windows backslash separators", () => {
    expect(getWorkflowName("C:\\Users\\dev\\feature.flightpath.json")).toBe("feature");
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
