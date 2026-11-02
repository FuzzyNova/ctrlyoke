import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ImportedOriginBadge } from "@components/shared/ImportedOriginBadge";

describe("ImportedOriginBadge", () => {
  it("names the bundle, source root, and export time accessibly", () => {
    render(
      <ImportedOriginBadge
        kind="runBundle"
        description="Imported from triage.ctrlyokerun; source /source/project; exported 2026-10-31T12:00:00.000Z"
      />
    );

    const badge = screen.getByLabelText(
      "Imported from triage.ctrlyokerun; source /source/project; exported 2026-10-31T12:00:00.000Z"
    );
    expect(badge.textContent).toBe("Imported");
    expect(badge.getAttribute("title")).toContain("triage.ctrlyokerun");
  });
});
