import { describe, it, expect } from "vitest";
import {
  parseRoute,
  serializeRoute,
  routesEqual,
  sameNavigation,
  normalizeRoute,
  deriveRoute,
  type Route,
  type RouteSourceState,
} from "@/navigation/route";

// ---------------------------------------------------------------------------
// parseRoute
// ---------------------------------------------------------------------------

describe("parseRoute", () => {
  it("returns an empty route for an empty search", () => {
    expect(parseRoute("")).toEqual({});
  });

  it("ignores the auth token", () => {
    expect(parseRoute("?token=abc123")).toEqual({});
  });

  it("parses a workflow and forward-slash normalizes it", () => {
    expect(parseRoute("?workflow=src%5Cflows%5Cmain.yaml")).toEqual({
      workflow: "src/flows/main.yaml",
    });
  });

  it("maps viewer=explorer with a file and line range", () => {
    expect(parseRoute("?viewer=explorer&file=src/a.ts&lines=10-20")).toEqual({
      viewer: "explorer",
      file: "src/a.ts",
      lines: [10, 20],
    });
  });

  it("maps viewer=explorer with a directory when no file is present", () => {
    expect(parseRoute("?viewer=explorer&dir=src/sub")).toEqual({
      viewer: "explorer",
      dir: "src/sub",
    });
  });

  it("maps viewer=scm to the sourceControl tab with a git ref", () => {
    expect(parseRoute("?viewer=scm&ref=~staged")).toEqual({
      viewer: "sourceControl",
      ref: "~staged",
    });
  });

  it("maps viewer=scm with a diff file when no ref is present", () => {
    expect(parseRoute("?viewer=scm&file=src/a.ts")).toEqual({
      viewer: "sourceControl",
      file: "src/a.ts",
    });
  });

  it("prefers file over dir in the explorer", () => {
    expect(parseRoute("?viewer=explorer&file=src/a.ts&dir=src/sub")).toEqual({
      viewer: "explorer",
      file: "src/a.ts",
    });
  });

  it("prefers ref over file in source control", () => {
    expect(parseRoute("?viewer=scm&ref=abc123&file=src/a.ts")).toEqual({
      viewer: "sourceControl",
      ref: "abc123",
    });
  });

  it("drops file/dir/ref when no viewer is present", () => {
    expect(parseRoute("?file=src/a.ts&dir=src&ref=abc")).toEqual({});
  });

  it("ignores an unknown viewer value", () => {
    expect(parseRoute("?viewer=settings&file=src/a.ts")).toEqual({});
  });

  it("ignores malformed line ranges", () => {
    const route = parseRoute("?viewer=explorer&file=src/a.ts&lines=abc");
    expect(route.lines).toBeUndefined();
  });

  it("ignores non-positive line ranges", () => {
    const route = parseRoute("?viewer=explorer&file=src/a.ts&lines=0-5");
    expect(route.lines).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// serializeRoute
// ---------------------------------------------------------------------------

describe("serializeRoute", () => {
  it("returns an empty string for an empty route with no token", () => {
    expect(serializeRoute({})).toBe("");
  });

  it("preserves the auth token from the current search", () => {
    const out = serializeRoute({ workflow: "a.yaml" }, "?token=secret");
    const params = new URLSearchParams(out);
    expect(params.get("token")).toBe("secret");
    expect(params.get("workflow")).toBe("a.yaml");
  });

  it("encodes the sourceControl tab as the short scm token", () => {
    const out = serializeRoute({ viewer: "sourceControl", ref: "abc123" });
    const params = new URLSearchParams(out);
    expect(params.get("viewer")).toBe("scm");
    expect(params.get("ref")).toBe("abc123");
  });

  it("encodes an explorer file with a line range", () => {
    const out = serializeRoute({
      viewer: "explorer",
      file: "src/a.ts",
      lines: [3, 9],
    });
    const params = new URLSearchParams(out);
    expect(params.get("viewer")).toBe("explorer");
    expect(params.get("file")).toBe("src/a.ts");
    expect(params.get("lines")).toBe("3-9");
  });

  it.each<Route>([
    {},
    { workflow: "src/flows/main.yaml" },
    { workflow: "a.yaml", viewer: "explorer", file: "src/a.ts" },
    { viewer: "explorer", file: "src/a.ts", lines: [10, 20] },
    { viewer: "explorer", dir: "src/sub" },
    { viewer: "sourceControl", ref: "~diff" },
    { viewer: "sourceControl", file: "src/a.ts" },
  ])("round-trips %o through serialize → parse", (route) => {
    expect(parseRoute(serializeRoute(route, "?token=t"))).toEqual(
      normalizeRoute(route)
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeRoute
// ---------------------------------------------------------------------------

describe("normalizeRoute", () => {
  it("drops nested fields when no viewer is set", () => {
    expect(
      normalizeRoute({ file: "src/a.ts", dir: "src", ref: "abc" })
    ).toEqual({});
  });

  it("drops dir and lines in source control", () => {
    expect(
      normalizeRoute({
        viewer: "sourceControl",
        file: "src/a.ts",
        dir: "src",
        lines: [1, 2],
      })
    ).toEqual({ viewer: "sourceControl", file: "src/a.ts" });
  });

  it("forward-slash normalizes all paths", () => {
    expect(
      normalizeRoute({
        workflow: "a\\b.yaml",
        viewer: "explorer",
        file: "src\\a.ts",
      })
    ).toEqual({ workflow: "a/b.yaml", viewer: "explorer", file: "src/a.ts" });
  });
});

// ---------------------------------------------------------------------------
// routesEqual
// ---------------------------------------------------------------------------

describe("routesEqual", () => {
  it("treats structurally identical routes as equal", () => {
    expect(
      routesEqual(
        { viewer: "explorer", file: "src/a.ts", lines: [1, 2] },
        { viewer: "explorer", file: "src/a.ts", lines: [1, 2] }
      )
    ).toBe(true);
  });

  it("normalizes before comparing", () => {
    expect(
      routesEqual(
        { viewer: "explorer", file: "src\\a.ts" },
        { viewer: "explorer", file: "src/a.ts", dir: "ignored" }
      )
    ).toBe(true);
  });

  it("distinguishes different files", () => {
    expect(
      routesEqual(
        { viewer: "explorer", file: "src/a.ts" },
        { viewer: "explorer", file: "src/b.ts" }
      )
    ).toBe(false);
  });

  it("distinguishes different line ranges", () => {
    expect(
      routesEqual(
        { viewer: "explorer", file: "src/a.ts", lines: [1, 2] },
        { viewer: "explorer", file: "src/a.ts", lines: [1, 3] }
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sameNavigation
// ---------------------------------------------------------------------------

describe("sameNavigation", () => {
  it("treats routes differing only by line range as the same navigation", () => {
    expect(
      sameNavigation(
        { viewer: "explorer", file: "src/a.ts", lines: [10, 20] },
        { viewer: "explorer", file: "src/a.ts" }
      )
    ).toBe(true);
  });

  it("distinguishes a different file", () => {
    expect(
      sameNavigation(
        { viewer: "explorer", file: "src/a.ts" },
        { viewer: "explorer", file: "src/b.ts" }
      )
    ).toBe(false);
  });

  it("distinguishes acquiring a workflow", () => {
    expect(sameNavigation({}, { workflow: "a.yaml" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveRoute
// ---------------------------------------------------------------------------

describe("deriveRoute", () => {
  const base: RouteSourceState = {
    activeWorkflowWorkingFilePath: null,
    isOpen: false,
    activeTab: "explorer",
    selectedFilePath: null,
    explorerPath: "",
    selectedDiffPath: null,
    diffRef: null,
  };

  it("derives the workflow path when the viewer is closed", () => {
    expect(
      deriveRoute({ ...base, activeWorkflowWorkingFilePath: "src/m.yaml" })
    ).toEqual({ workflow: "src/m.yaml" });
  });

  it("omits the viewer when it is closed", () => {
    expect(
      deriveRoute({ ...base, isOpen: false, selectedFilePath: "src/a.ts" })
    ).toEqual({});
  });

  it("derives an explorer file route", () => {
    expect(
      deriveRoute({
        ...base,
        isOpen: true,
        activeTab: "explorer",
        selectedFilePath: "src/a.ts",
      })
    ).toEqual({ viewer: "explorer", file: "src/a.ts" });
  });

  it("derives an explorer directory route when no file is selected", () => {
    expect(
      deriveRoute({
        ...base,
        isOpen: true,
        activeTab: "explorer",
        explorerPath: "src/sub",
      })
    ).toEqual({ viewer: "explorer", dir: "src/sub" });
  });

  it("derives just the explorer tab at the workspace root", () => {
    expect(
      deriveRoute({ ...base, isOpen: true, activeTab: "explorer" })
    ).toEqual({ viewer: "explorer" });
  });

  it("derives a git ref route in source control", () => {
    expect(
      deriveRoute({
        ...base,
        isOpen: true,
        activeTab: "sourceControl",
        diffRef: "~staged",
      })
    ).toEqual({ viewer: "sourceControl", ref: "~staged" });
  });

  it("derives a diff file route when no ref is active", () => {
    expect(
      deriveRoute({
        ...base,
        isOpen: true,
        activeTab: "sourceControl",
        selectedDiffPath: "src/a.ts",
      })
    ).toEqual({ viewer: "sourceControl", file: "src/a.ts" });
  });

  it("does not derive selection lines", () => {
    const route = deriveRoute({
      ...base,
      isOpen: true,
      activeTab: "explorer",
      selectedFilePath: "src/a.ts",
    });
    expect(route.lines).toBeUndefined();
  });
});
