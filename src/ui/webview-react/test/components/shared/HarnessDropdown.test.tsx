import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { HarnessDropdown } from "@components/shared/HarnessDropdown";
import { HARNESS_IDS } from "@root/types/DashboardConstants";

describe("HarnessDropdown", () => {
  it("renders the hidden toggle after inline options", () => {
    const { container } = render(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        hiddenValues={[HARNESS_IDS.CLAUDE_CLI]}
        inline
      />
    );

    const wrapper = container.firstElementChild;
    expect(wrapper?.lastElementChild?.textContent).toContain("Show hidden");
  });
});
