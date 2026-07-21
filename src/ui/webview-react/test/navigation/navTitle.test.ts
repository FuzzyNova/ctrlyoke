import { describe, it, expect } from "vitest";
import { routeTitle } from "@/navigation/navTitle";

describe("routeTitle", () => {
  it("is the bare app name for an empty route", () => {
    expect(routeTitle({})).toBe("ctrlyoke");
  });

  it("uses the stable run label when no viewer is open", () => {
    expect(
      routeTitle({
        workflow: {
          workflowKey: "main" as never,
          kind: "run",
          runRef: "run-2026-07-20T10-30-00-000Z" as never,
        },
      })
    ).toBe("Run run-2026-07-20T10-30-00-000Z — ctrlyoke");
  });

  it("uses the explorer file basename", () => {
    expect(routeTitle({ viewer: "explorer", file: "src/app/index.ts" })).toBe(
      "index.ts — ctrlyoke"
    );
  });

  it("labels an explorer directory", () => {
    expect(routeTitle({ viewer: "explorer", dir: "src/app" })).toBe(
      "app/ — ctrlyoke"
    );
  });

  it("labels a diff file in source control", () => {
    expect(routeTitle({ viewer: "sourceControl", file: "src/a.ts" })).toBe(
      "a.ts (diff) — ctrlyoke"
    );
  });

  it("labels named refs", () => {
    expect(routeTitle({ viewer: "sourceControl", ref: "~staged" })).toBe(
      "Staged Changes — ctrlyoke"
    );
    expect(routeTitle({ viewer: "sourceControl", ref: "~stash:2" })).toBe(
      "Stash #2 — ctrlyoke"
    );
  });

  it("shortens a commit hash ref", () => {
    expect(
      routeTitle({ viewer: "sourceControl", ref: "abcdef1234567890" })
    ).toBe("Commit abcdef1 — ctrlyoke");
  });
});
