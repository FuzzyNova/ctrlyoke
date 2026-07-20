import { describe, it, expect, beforeEach } from "vitest";
import {
  useNavHistoryStore,
  canGoBack,
  canGoForward,
} from "@/navigation/navHistoryStore";
import type { Route } from "@/navigation/route";

beforeEach(() => {
  useNavHistoryStore.getState().reset();
});

function store() {
  return useNavHistoryStore.getState();
}

const A: Route = { workflow: { workflowKey: "a" as never, kind: "draft" } };
const B: Route = { viewer: "explorer", file: "src/a.ts" };
const C: Route = { viewer: "sourceControl", ref: "abc123" };

describe("initial state", () => {
  it("starts empty with no back or forward", () => {
    expect(store().past).toEqual([]);
    expect(store().current).toBeNull();
    expect(store().future).toEqual([]);
    expect(canGoBack(store())).toBe(false);
    expect(canGoForward(store())).toBe(false);
  });
});

describe("record", () => {
  it("sets the current route without creating past on the first entry", () => {
    store().record(A);
    expect(store().current).toEqual(A);
    expect(store().past).toEqual([]);
    expect(canGoBack(store())).toBe(false);
  });

  it("pushes the previous current onto past", () => {
    store().record(A);
    store().record(B);
    expect(store().current).toEqual(B);
    expect(store().past).toEqual([A]);
    expect(canGoBack(store())).toBe(true);
  });

  it("is a no-op when recording the current route again", () => {
    store().record(A);
    store().record({ workflow: { workflowKey: "a" as never, kind: "draft" } });
    expect(store().past).toEqual([]);
    expect(store().current).toEqual(A);
  });

  it("clears the forward stack on a new navigation", () => {
    store().record(A);
    store().record(B);
    store().back();
    expect(canGoForward(store())).toBe(true);
    store().record(C);
    expect(store().future).toEqual([]);
    expect(canGoForward(store())).toBe(false);
  });
});

describe("back", () => {
  it("returns null and stays put when there is no past", () => {
    store().record(A);
    expect(store().back()).toBeNull();
    expect(store().current).toEqual(A);
  });

  it("moves the cursor back and exposes a forward entry", () => {
    store().record(A);
    store().record(B);
    const result = store().back();
    expect(result).toEqual(A);
    expect(store().current).toEqual(A);
    expect(store().future).toEqual([B]);
    expect(canGoForward(store())).toBe(true);
    expect(canGoBack(store())).toBe(false);
  });
});

describe("forward", () => {
  it("returns null at the tip of history", () => {
    store().record(A);
    expect(store().forward()).toBeNull();
  });

  it("re-applies the next entry after going back", () => {
    store().record(A);
    store().record(B);
    store().back();
    const result = store().forward();
    expect(result).toEqual(B);
    expect(store().current).toEqual(B);
    expect(store().past).toEqual([A]);
    expect(store().future).toEqual([]);
  });

  it("walks a multi-entry stack back and forward", () => {
    store().record(A);
    store().record(B);
    store().record(C);
    expect(store().back()).toEqual(B);
    expect(store().back()).toEqual(A);
    expect(canGoBack(store())).toBe(false);
    expect(store().forward()).toEqual(B);
    expect(store().forward()).toEqual(C);
    expect(canGoForward(store())).toBe(false);
  });
});

describe("reset", () => {
  it("clears the entire stack", () => {
    store().record(A);
    store().record(B);
    store().reset();
    expect(store().past).toEqual([]);
    expect(store().current).toBeNull();
    expect(store().future).toEqual([]);
  });
});
