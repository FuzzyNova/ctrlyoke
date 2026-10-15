import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  HARNESS_IDS,
} from "@root/types/DashboardConstants";
import { CompatibilitySummary } from "@components/shared/FieldDiagnostic";

describe("CompatibilitySummary", () => {
  it("does not show the warning badge for informational diagnostics", () => {
    render(
      <CompatibilitySummary
        diagnostics={[
          {
            severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.INFO,
            message: "Allowed Tools are enforced with an advisory note.",
            harnessId: HARNESS_IDS.CLAUDE_CLI,
          },
        ]}
        onReview={vi.fn()}
      />
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the warning badge for warning diagnostics", () => {
    render(
      <CompatibilitySummary
        diagnostics={[
          {
            severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
            message: "Allowed Tools are not enforced.",
            harnessId: HARNESS_IDS.CODEX_CLI,
          },
        ]}
        onReview={vi.fn()}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "1 compatibility warning"
    );
  });
});
