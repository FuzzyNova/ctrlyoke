import { describe, it, expect } from "vitest";
import { preserveReferences } from "@utils/structuralSharing";

describe("preserveReferences", () => {
  it("returns next when values are identical references", () => {
    const value = { a: 1 };
    expect(preserveReferences(value, value)).toBe(value);
  });

  it("returns prev when next is deep-equal", () => {
    const prev = { a: 1, list: [1, 2, { b: "x" }] };
    const next = { a: 1, list: [1, 2, { b: "x" }] };
    expect(preserveReferences(prev, next)).toBe(prev);
  });

  it("returns prev for deep-equal arrays", () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const next = [{ id: 1 }, { id: 2 }];
    expect(preserveReferences(prev, next)).toBe(prev);
  });

  it("reuses unchanged subtrees when siblings changed", () => {
    const prev = { steps: [{ prompt: "a" }, { prompt: "b" }], name: "old" };
    const next = { steps: [{ prompt: "a" }, { prompt: "b" }], name: "new" };
    const result = preserveReferences(prev, next);
    expect(result).not.toBe(prev);
    expect(result.name).toBe("new");
    expect(result.steps).toBe(prev.steps);
  });

  it("reuses unchanged array items when one item changed", () => {
    const prev = [{ prompt: "a" }, { prompt: "b" }];
    const next = [{ prompt: "a" }, { prompt: "c" }];
    const result = preserveReferences(prev, next);
    expect(result).not.toBe(prev);
    expect(result[0]).toBe(prev[0]);
    expect(result[1]).toBe(next[1]);
  });

  it("returns next when array lengths differ, still sharing common items", () => {
    const prev = [{ prompt: "a" }];
    const next = [{ prompt: "a" }, { prompt: "b" }];
    const result = preserveReferences(prev, next);
    expect(result).not.toBe(prev);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(prev[0]);
  });

  it("returns prev for equal empty containers", () => {
    const prevArr: unknown[] = [];
    const prevObj: Record<string, unknown> = {};
    expect(preserveReferences(prevArr, [])).toBe(prevArr);
    expect(preserveReferences(prevObj, {})).toBe(prevObj);
  });

  it("does not treat missing and undefined-valued keys as equal", () => {
    const prev = { a: 1 };
    const next = { a: 1, b: undefined };
    const result = preserveReferences(prev, next);
    expect(result).not.toBe(prev);
    expect("b" in result).toBe(true);
  });

  it("distinguishes objects with different key counts", () => {
    const prev = { a: 1, b: 2 };
    const next = { a: 1 };
    const result = preserveReferences(prev, next);
    expect(result).not.toBe(prev);
    expect(result).toEqual({ a: 1 });
  });

  it("passes through primitives and mismatched types", () => {
    expect(preserveReferences(1, 2)).toBe(2);
    expect(preserveReferences("a", "a")).toBe("a");
    expect(preserveReferences(null, { a: 1 })).toEqual({ a: 1 });
    expect(preserveReferences({ a: 1 }, null)).toBeNull();
    expect(preserveReferences([1], { 0: 1 })).toEqual({ 0: 1 });
  });

  it("does not merge class instances", () => {
    class Thing {
      constructor(public value: number) {}
    }
    const prev = new Thing(1);
    const next = new Thing(1);
    expect(preserveReferences(prev, next)).toBe(next);
  });
});
