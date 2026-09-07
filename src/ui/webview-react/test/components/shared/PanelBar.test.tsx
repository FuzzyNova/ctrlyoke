import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PanelBar } from "@components/shared/PanelBar";

describe("PanelBar", () => {
  it.each(["horizontal", "vertical"] as const)(
    "expands the %s panel from Space",
    async (orientation) => {
      const user = userEvent.setup();
      const onClick = vi.fn();

      render(
        <PanelBar
          title="Output"
          icon="output"
          orientation={orientation}
          onClick={onClick}
        />
      );

      const button = screen.getByRole("button", { name: "Expand Output" });
      button.focus();
      await user.keyboard(" ");

      expect(onClick).toHaveBeenCalledOnce();
    }
  );
});
