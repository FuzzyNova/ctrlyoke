import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingToggleRow } from "@components/shared/SettingToggleRow";

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
});
