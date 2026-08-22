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
          { type: "literal", text: "model:" },
          { type: "field", field: STATUS_LINE_FIELD_IDS.MODEL },
        ]}
      />
    );

    expect(screen.getByText(/model: claude-sonnet-4\.5/)).toBeInTheDocument();
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
});
