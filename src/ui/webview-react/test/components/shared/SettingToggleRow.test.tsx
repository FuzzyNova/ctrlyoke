import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  INHERIT_DEFAULT_OPTION,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import type { SettingSource } from "@root/types/WebviewMessageTypes";
import { SettingToggleRow } from "@components/shared/SettingToggleRow";

const unavailableSources: [string, SettingSource | undefined][] = [
  ["inherited", INHERIT_DEFAULT_OPTION],
  ["undefined", undefined],
];

describe("SettingToggleRow schema labels", () => {
  it("adds the settings property to the toggle tooltip and accessible name", () => {
    render(
      <SettingToggleRow
        label="Auto Start"
        path="server.autoStart"
        checked={false}
        onChange={() => undefined}
      />
    );

    const toggle = screen.getByRole("checkbox", {
      name: "Auto Start, property server.autoStart",
    });
    expect(toggle).toHaveAttribute(
      "title",
      expect.stringContaining("property: server.autoStart")
    );
  });

  it("keeps toggles outside search context undecorated", () => {
    const { container } = render(
      <SettingToggleRow
        label="Auto Start"
        checked={false}
        onChange={() => undefined}
      />
    );
    expect(container.firstElementChild).not.toHaveClass(
      "rounded-sm",
      "bg-list-hover-bg/50"
    );
    expect(container.querySelector("mark")).toBeNull();
  });

  it("enables reset for the active source scope and calls onReset without toggling", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <SettingToggleRow
        label="Auto Start"
        path="server.autoStart"
        checked={false}
        onChange={onChange}
        sources={{ "server.autoStart": SETTING_SCOPES.USER }}
        activeScope={SETTING_SCOPES.USER}
        onReset={onReset}
      />
    );

    const reset = screen.getByRole("button", { name: "Reset Auto Start" });
    expect(reset).toBeEnabled();
    expect(reset).toHaveAttribute("title", "Reset to default");
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledWith("server.autoStart");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("disables reset when the setting comes from another scope", () => {
    render(
      <SettingToggleRow
        label="Auto Start"
        path="server.autoStart"
        checked={false}
        onChange={() => undefined}
        sources={{ "server.autoStart": SETTING_SCOPES.WORKSPACE }}
        activeScope={SETTING_SCOPES.USER}
        onReset={() => undefined}
      />
    );

    const reset = screen.getByRole("button", { name: "Reset Auto Start" });
    expect(reset).toBeDisabled();
    expect(reset).toHaveAttribute("title", "Defined in workspace config");
  });

  it.each(unavailableSources)(
    "disables reset for an %s source",
    (_name, source) => {
      render(
        <SettingToggleRow
          label="Auto Start"
          path="server.autoStart"
          checked={false}
          onChange={() => undefined}
          sources={source ? { "server.autoStart": source } : {}}
          activeScope={SETTING_SCOPES.USER}
          onReset={() => undefined}
        />
      );

      const reset = screen.getByRole("button", { name: "Reset Auto Start" });
      expect(reset).toBeDisabled();
      if (source) {
        expect(reset).toHaveAttribute("title", `Defined in ${source} config`);
      } else {
        expect(reset).not.toHaveAttribute("title");
      }
    }
  );
});
