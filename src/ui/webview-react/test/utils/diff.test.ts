import { describe, it, expect } from "vitest";
import { generateDiff, applyDiff } from "@utils/diff";

describe("generateDiff", () => {
  it("returns an empty patch string for identical content", () => {
    const patch = generateDiff("hello\n", "hello\n");
    // diff.createPatch still produces headers but no ± lines
    expect(patch).not.toContain("+hello");
    expect(patch).not.toContain("-hello");
  });

  it("produces a unified diff with added lines", () => {
    const patch = generateDiff("line1\n", "line1\nline2\n");
    expect(patch).toContain("+line2");
  });

  it("produces a unified diff with removed lines", () => {
    const patch = generateDiff("line1\nline2\n", "line1\n");
    expect(patch).toContain("-line2");
  });

  it("returns a string (not null/undefined) for any inputs", () => {
    expect(typeof generateDiff("", "")).toBe("string");
    expect(typeof generateDiff("a", "b")).toBe("string");
  });
});

describe("applyDiff", () => {
  it("round-trips: apply the generated patch restores the new content", () => {
    const oldText = "line1\nline2\nline3\n";
    const newText = "line1\nmodified\nline3\n";
    const patch = generateDiff(oldText, newText);
    const result = applyDiff(oldText, patch);
    expect(result).toBe(newText);
  });

  it("returns original text when patch does not apply", () => {
    const result = applyDiff("unrelated text\n", "@@not a real patch");
    expect(result).toBe("unrelated text\n");
  });

  it("handles empty old text", () => {
    const patch = generateDiff("", "new content\n");
    const result = applyDiff("", patch);
    expect(result).toBe("new content\n");
  });
});
