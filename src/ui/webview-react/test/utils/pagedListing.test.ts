import { describe, expect, it } from "vitest";
import {
  isAbortError,
  listingKey,
  loadedRowCount,
  normalizePagedPath,
  normalizeRepo,
  pageOffset,
} from "@utils/pagedListing";

describe("pagedListing helpers", () => {
  it("aligns indices to page offsets and clamps negative indices", () => {
    expect(pageOffset(-3, 10)).toBe(0);
    expect(pageOffset(13, 10)).toBe(10);
  });

  it("recognizes abort errors", () => {
    expect(
      isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))
    ).toBe(true);
    expect(isAbortError(new Error("other"))).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });

  it("trims repository selectors and omits blank values", () => {
    expect(normalizeRepo("  repo  ")).toBe("repo");
    expect(normalizeRepo("   ")).toBeUndefined();
    expect(normalizeRepo(undefined)).toBeUndefined();
  });

  it("normalizes paged paths to forward slashes without a leading dot segment", () => {
    expect(normalizePagedPath(".\\a\\b")).toBe("a/b");
    expect(normalizePagedPath("a\\b")).toBe("a/b");
  });

  it("separates listing values from repository selectors", () => {
    expect(listingKey("main", undefined)).toBe("\u0000main");
    expect(listingKey("main", "repo")).toBe("repo\u0000main");
  });

  it("counts loaded rows and respects a minimum", () => {
    const pages = new Map<number, readonly string[]>([
      [0, ["a", "b"]],
      [10, ["c"]],
    ]);

    expect(loadedRowCount(pages)).toBe(3);
    expect(loadedRowCount(pages, 5)).toBe(5);
    expect(loadedRowCount(pages, 2)).toBe(3);
  });
});
