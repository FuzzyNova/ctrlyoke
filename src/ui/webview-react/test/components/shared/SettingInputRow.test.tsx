import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingInputRow } from "@components/shared/SettingInputRow";
import { SettingsSearchContext } from "@components/settings/SettingsSearchContext";

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

  it("tints path-only matches without highlighting visible text", () => {
    const { container } = render(
      <SettingsSearchContext.Provider
        value={{
          tokens: ["que"],
          matchIds: new Set(["queue.maxSteps"]),
          activeMatchId: null,
        }}
      >
        <SettingInputRow settingKey="queue.maxSteps">
          <input />
        </SettingInputRow>
      </SettingsSearchContext.Provider>
    );
    expect(
      container.querySelector("[data-settings-search-id='queue.maxSteps']")
    ).toHaveClass("bg-list-hover-bg/50");
    expect(container.querySelector("mark")).toBeNull();
  });

  it("keeps rows outside search context undecorated", () => {
    const { container } = render(
      <SettingInputRow label="Port" id="port" path="server.port">
        <input id="port" />
      </SettingInputRow>
    );
    expect(container.firstElementChild).toHaveClass("group");
    expect(container.firstElementChild).not.toHaveClass(
      "rounded-sm",
      "bg-list-hover-bg/50"
    );
    expect(container.querySelector("mark")).toBeNull();
  });
});
