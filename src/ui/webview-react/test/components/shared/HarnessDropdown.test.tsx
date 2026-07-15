import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HarnessDropdown } from "@components/shared/HarnessDropdown";
import { HARNESS_IDS } from "@root/types/DashboardConstants";
import { HarnessPreflightPanel } from "@components/layout/HarnessPreflightPanel";
import { useSettingsStore } from "@store/settingsStore";

const originalHarnessStatus = useSettingsStore.getState().harnessStatus;

afterEach(() => {
  useSettingsStore.setState({ harnessStatus: originalHarnessStatus });
});

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

  it("shows an unavailable harness install hint on hover", () => {
    render(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        harnessStatus={{
          [HARNESS_IDS.COPILOT_CLI]: {
            available: false,
            status: "unavailable",
            installHint: "Install via: npm install -g @github/copilot",
          },
        }}
      />
    );

    expect(
      screen.getByTitle("Install via: npm install -g @github/copilot")
    ).toBeInTheDocument();
  });

  it("shows preflight guidance only when every harness is unavailable", () => {
    useSettingsStore.setState({
      harnessStatus: Object.fromEntries(
        Object.values(HARNESS_IDS).map((id) => [
          id,
          {
            available: false,
            status: "unavailable",
            installHint: `Install ${id}`,
          },
        ])
      ) as typeof originalHarnessStatus,
    });

    render(<HarnessPreflightPanel />);

    expect(
      screen.getByText("No AI harness CLI is available")
    ).toBeInTheDocument();
    expect(screen.getByText("Install codex-cli")).toBeInTheDocument();
  });
});
