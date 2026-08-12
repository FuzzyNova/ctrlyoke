import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorktreesSection } from "@components/settings/WorktreesSection";
import { SETTING_SCOPES } from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function createSettings(root = ""): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      worktrees: { root },
    },
    sources: {},
    isMultiRoot: false,
  };
}

describe("WorktreesSection", () => {
  it("shows the effective root and locks the setting at workspace scope", () => {
    render(
      <WorktreesSection
        settings={createSettings("C:/worktrees")}
        activeScope={SETTING_SCOPES.WORKSPACE}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Worktree root")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("C:/worktrees");
    expect(
      screen.getByText(/user-scoped and cannot be changed/i)
    ).toBeInTheDocument();
  });

  it("describes the automatic resolution tiers when no root is configured", () => {
    render(
      <WorktreesSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(
      screen.getByText("Automatic repository worktree root")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/repository sibling, then user fallback/i)
    ).toBeInTheDocument();
  });
});
