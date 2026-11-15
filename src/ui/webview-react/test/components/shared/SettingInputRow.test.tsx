import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  INHERIT_DEFAULT_OPTION,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import type { SettingSource } from "@root/types/WebviewMessageTypes";
import { SettingInputRow } from "@components/shared/SettingInputRow";
import { SettingsSearchContext } from "@components/settings/SettingsSearchContext";

const unavailableSources: [string, SettingSource | undefined][] = [
  ["inherited", INHERIT_DEFAULT_OPTION],
  ["undefined", undefined],
];

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

  it("enables reset for the active source scope and calls onReset", () => {
    const onReset = vi.fn();
    render(
      <SettingInputRow
        label="Port"
        path="server.port"
        sources={{ "server.port": SETTING_SCOPES.USER }}
        activeScope={SETTING_SCOPES.USER}
        onReset={onReset}
      >
        <input />
      </SettingInputRow>
    );

    const reset = screen.getByRole("button", { name: "Reset Port" });
    expect(reset).toBeEnabled();
    expect(reset).toHaveAttribute("title", "Reset to default");
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledWith("server.port");
  });

  it("disables reset when the setting comes from another scope", () => {
    render(
      <SettingInputRow
        label="Port"
        path="server.port"
        sources={{ "server.port": SETTING_SCOPES.WORKSPACE }}
        activeScope={SETTING_SCOPES.USER}
        onReset={() => undefined}
      >
        <input />
      </SettingInputRow>
    );

    const reset = screen.getByRole("button", { name: "Reset Port" });
    expect(reset).toBeDisabled();
    expect(reset).toHaveAttribute("title", "Defined in workspace config");
  });

  it.each(unavailableSources)(
    "disables reset for an %s source",
    (_name, source) => {
      render(
        <SettingInputRow
          label="Port"
          path="server.port"
          sources={source ? { "server.port": source } : {}}
          activeScope={SETTING_SCOPES.USER}
          onReset={() => undefined}
        >
          <input />
        </SettingInputRow>
      );

      const reset = screen.getByRole("button", { name: "Reset Port" });
      expect(reset).toBeDisabled();
      if (source) {
        expect(reset).toHaveAttribute("title", `Defined in ${source} config`);
      } else {
        expect(reset).not.toHaveAttribute("title");
      }
    }
  );
});
