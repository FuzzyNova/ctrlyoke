import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DiffView } from "@components/output/DiffView";
import { useSettingsStore } from "@store/settingsStore";

describe("DiffView Markdown table rendering", () => {
  afterEach(() => {
    cleanup();
    document.head
      .querySelector('[data-test="tailwind-table-collision"]')
      ?.remove();
  });

  it("keeps each highlighted table row on one line with inline token elements", () => {
    // Reproduce Tailwind's colliding utility: Prism/Refractor emits a `table`
    // token class, while Tailwind's `.table` class sets display: table.
    const tailwindCollision = document.createElement("style");
    tailwindCollision.dataset.test = "tailwind-table-collision";
    tailwindCollision.textContent = ".table { display: table; }";
    document.head.append(tailwindCollision);

    useSettingsStore.getState().updateGlobalSetting("wordWrap", true);

    const { container } = render(
      <DiffView
        structuredPatch={[
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 3,
            lines: [
              "+| Method | Path | Description |",
              "+|---|---|---|",
              "+| GET | /v1/items | List items |",
            ],
          },
        ]}
        language="markdown"
        viewType="unified"
        globallyCollapsed={false}
      />
    );

    const lines = Array.from(container.querySelectorAll(".diff-line"));
    expect(lines).toHaveLength(3);
    expect(
      lines.map((line) => line.querySelector(".diff-code")?.textContent)
    ).toEqual([
      "| Method | Path | Description |",
      "|---|---|---|",
      "| GET | /v1/items | List items |",
    ]);

    const tableTokens = container.querySelectorAll(".diff .token.table");
    expect(tableTokens.length).toBeGreaterThan(0);
    for (const token of tableTokens) {
      expect(getComputedStyle(token).display).toBe("inline");
    }

    tailwindCollision.remove();
  });
});
