import { describe, it, expect } from "vitest";
import { routeTitle } from "@/navigation/navTitle";

describe("routeTitle", () => {
  it("is the bare app name for an empty route", () => {
    expect(routeTitle({})).toBe("FlightPath");
  });

  it("uses the workflow basename when no viewer is open", () => {
    expect(routeTitle({ workflow: "src/flows/main.yaml" })).toBe(
      "main.yaml — FlightPath"
    );
  });

  it("uses the explorer file basename", () => {
    expect(routeTitle({ viewer: "explorer", file: "src/app/index.ts" })).toBe(
      "index.ts — FlightPath"
    );
  });

  it("labels an explorer directory", () => {
    expect(routeTitle({ viewer: "explorer", dir: "src/app" })).toBe(
      "app/ — FlightPath"
    );
  });

  it("labels a diff file in source control", () => {
    expect(routeTitle({ viewer: "sourceControl", file: "src/a.ts" })).toBe(
      "a.ts (diff) — FlightPath"
    );
  });

  it("labels named refs", () => {
    expect(routeTitle({ viewer: "sourceControl", ref: "~staged" })).toBe(
      "Staged Changes — FlightPath"
    );
    expect(routeTitle({ viewer: "sourceControl", ref: "~stash:2" })).toBe(
      "Stash #2 — FlightPath"
    );
  });

  it("shortens a commit hash ref", () => {
    expect(
      routeTitle({ viewer: "sourceControl", ref: "abcdef1234567890" })
    ).toBe("Commit abcdef1 — FlightPath");
  });
});
