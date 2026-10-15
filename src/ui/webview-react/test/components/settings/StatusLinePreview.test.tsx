import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusLinePreview } from "@components/settings/stats/StatusLinePreview";
import {
  STATUS_LINE_FIELD_IDS,
  STATUS_LINE_FORMAT_PROVIDERS,
} from "@root/utils/StatuslineFormat";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
} from "@root/types/DashboardConstants";
import type { HarnessUsageSnapshot } from "@root/types/UsageTypes";

describe("StatusLinePreview", () => {
  it("renders the formatted line for the supplied format", () => {
    render(
      <StatusLinePreview
        format={[
          { type: "field", field: STATUS_LINE_FIELD_IDS.MODEL },
          { type: "literal", text: "·" },
          { type: "field", field: STATUS_LINE_FIELD_IDS.VERSION },
        ]}
      />
    );

    expect(
      screen.getByText(/claude-sonnet-4\.5 · preview/)
    ).toBeInTheDocument();
  });

  it("uses the same default usage label for every provider", () => {
    const { rerender } = render(
      <StatusLinePreview
        format={[{ type: "field", field: STATUS_LINE_FIELD_IDS.USAGE }]}
        provider={STATUS_LINE_FORMAT_PROVIDERS.CLAUDE}
      />
    );

    expect(screen.getByText("usage 41%")).toBeInTheDocument();

    rerender(
      <StatusLinePreview
        format={[{ type: "field", field: STATUS_LINE_FIELD_IDS.USAGE }]}
        provider={STATUS_LINE_FORMAT_PROVIDERS.ANTIGRAVITY}
      />
    );

    expect(screen.getByText("usage 41%")).toBeInTheDocument();
  });

  it("labels a Claude snapshot containing only the seven-day window as weekly", () => {
    const snapshot: HarnessUsageSnapshot = {
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      updatedAt: 1,
      quota: {
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
        staleAfterMs: 60_000,
        windows: [
          {
            id: "seven-day",
            kind: HARNESS_USAGE_WINDOW_KINDS.WEEKLY,
            label: "week",
            percentUsed: 41,
            unit: HARNESS_USAGE_UNITS.PERCENT,
            confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
          },
        ],
      },
      observed: {},
    };

    render(
      <StatusLinePreview
        format={[{ type: "field", field: STATUS_LINE_FIELD_IDS.USAGE_2 }]}
        provider={STATUS_LINE_FORMAT_PROVIDERS.CLAUDE}
        snapshot={snapshot}
      />
    );

    expect(screen.getByText("week 41%")).toBeInTheDocument();
    expect(screen.queryByText(/5h/)).not.toBeInTheDocument();
  });

  it.each([
    [STATUS_LINE_FORMAT_PROVIDERS.COPILOT, "gpt-5.6-luna"],
    [STATUS_LINE_FORMAT_PROVIDERS.QWEN, "[ModelStudio Standard] qwen3.5-plus"],
  ] as const)("renders the captured %s model fixture", (provider, model) => {
    render(
      <StatusLinePreview
        format={[{ type: "field", field: STATUS_LINE_FIELD_IDS.MODEL }]}
        provider={provider}
      />
    );

    expect(screen.getByText(model)).toBeInTheDocument();
  });

  it.each([
    [STATUS_LINE_FORMAT_PROVIDERS.COPILOT, "26.2k/328.0k ctx (8%)"],
    [STATUS_LINE_FORMAT_PROVIDERS.QWEN, "42.7k/1.0M ctx (4.3%)"],
  ] as const)(
    "renders the captured %s context fixture",
    (provider, context) => {
      render(
        <StatusLinePreview
          format={[{ type: "field", field: STATUS_LINE_FIELD_IDS.CONTEXT }]}
          provider={provider}
        />
      );

      expect(screen.getByText(context)).toBeInTheDocument();
    }
  );
});
