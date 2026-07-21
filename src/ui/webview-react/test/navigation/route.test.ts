import { describe, it, expect } from "vitest";
import {
  deriveRoute,
  normalizeRoute,
  parseRoute,
  routesEqual,
  sameNavigation,
  serializeRoute,
  type Route,
  type RouteSourceState,
} from "@/navigation/route";

const DRAFT = { workflowKey: "demo" as never, kind: "draft" as const };
const RUN = {
  workflowKey: "demo" as never,
  kind: "run" as const,
  runRef: "run-2026-07-20T10-30-00-000Z" as never,
};

describe("workflow run routes", () => {
  it("parses a stable promoted-run address", () => {
    expect(
      parseRoute("?workflowKey=demo&runRef=run-2026-07-20T10-30-00-000Z")
    ).toEqual({ workflow: RUN });
  });

  it("parses a lineage draft when no run ref is present", () => {
    expect(parseRoute("?workflowKey=demo")).toEqual({ workflow: DRAFT });
  });

  it("serializes a stable address while preserving the token", () => {
    const params = new URLSearchParams(
      serializeRoute({ workflow: RUN }, "?token=t")
    );
    expect(params.get("token")).toBe("t");
    expect(params.get("workflowKey")).toBe("demo");
    expect(params.get("runRef")).toBe(RUN.runRef);
    expect(params.get("workflow")).toBeNull();
  });

  it.each<Route>([
    {},
    { workflow: DRAFT },
    { workflow: RUN, viewer: "explorer", file: "src/a.ts" },
    { viewer: "sourceControl", ref: "~diff" },
  ])("round-trips %o", (route) => {
    expect(parseRoute(serializeRoute(route, "?token=t"))).toEqual(
      normalizeRoute(route)
    );
  });

  it("distinguishes runs in the same lineage", () => {
    expect(
      sameNavigation(RUN ? { workflow: RUN } : {}, {
        workflow: { ...RUN, runRef: "run-2026-07-20T10-31-00-000Z" as never },
      })
    ).toBe(false);
  });

  it("normalizes nested viewer fields", () => {
    expect(
      normalizeRoute({
        viewer: "sourceControl",
        file: "src/a.ts",
        dir: "src",
        lines: [1, 2],
      })
    ).toEqual({ viewer: "sourceControl", file: "src/a.ts" });
  });

  it("includes line ranges in structural equality but not navigation equality", () => {
    const a: Route = { viewer: "explorer", file: "src/a.ts", lines: [1, 2] };
    const b: Route = { viewer: "explorer", file: "src/a.ts" };
    expect(routesEqual(a, b)).toBe(false);
    expect(sameNavigation(a, b)).toBe(true);
  });
});

describe("deriveRoute", () => {
  const base: RouteSourceState = {
    displayedViewAddress: null,
    isOpen: false,
    activeTab: "explorer",
    selectedFilePath: null,
    explorerPath: "",
    selectedDiffPath: null,
    diffRef: null,
  };

  it("derives the stable selected run", () => {
    expect(deriveRoute({ ...base, displayedViewAddress: RUN })).toEqual({
      workflow: RUN,
    });
  });

  it("derives workspace viewer state alongside the address", () => {
    expect(
      deriveRoute({
        ...base,
        displayedViewAddress: DRAFT,
        isOpen: true,
        selectedFilePath: "src/a.ts",
      })
    ).toEqual({ workflow: DRAFT, viewer: "explorer", file: "src/a.ts" });
  });
});
