import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingInputRow } from "@components/shared/SettingInputRow";

describe("SettingInputRow schema labels", () => {
  it("adds the settings property to the tooltip and associated control name", () => {
    render(
      <SettingInputRow label="Port" id="server-port" path="server.port">
        <input id="server-port" type="number" />
      </SettingInputRow>
    );

    const label = screen.getByText("Port").closest("label");
    expect(label).toHaveAttribute(
      "title",
      expect.stringContaining("property: server.port")
    );
    expect(
      screen.getByRole("spinbutton", { name: "Port, property server.port" })
    ).toBeInTheDocument();
  });
});
