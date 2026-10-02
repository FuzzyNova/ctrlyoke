import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusLinePreview } from "@components/settings/stats/StatusLinePreview";
import {
  STATUS_LINE_FIELD_IDS,
  STATUS_LINE_FORMAT_PROVIDERS,
} from "@root/utils/StatuslineFormat";

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

    expect(screen.getByText(/claude-sonnet-4\.5 · preview/)).toBeInTheDocument();
  });

  it("uses the provider-specific default usage label", () => {
    const { rerender } = render(
      <StatusLinePreview
        format={[{ type: "field", field: STATUS_LINE_FIELD_IDS.USAGE }]}
        provider={STATUS_LINE_FORMAT_PROVIDERS.CLAUDE}
      />
    );

    expect(screen.getByText("rate 41%")).toBeInTheDocument();

    rerender(
      <StatusLinePreview
        format={[{ type: "field", field: STATUS_LINE_FIELD_IDS.USAGE }]}
        provider={STATUS_LINE_FORMAT_PROVIDERS.ANTIGRAVITY}
      />
    );

    expect(screen.getByText("quota 41%")).toBeInTheDocument();
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
