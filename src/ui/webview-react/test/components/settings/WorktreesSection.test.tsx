import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreesSection } from "@components/settings/WorktreesSection";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { useSettingsStore } from "@store/settingsStore";

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
  afterEach(() => {
    useSettingsStore.getState().setWorktreeManagement(null);
  });
  it("preselects only provably safe merged branches and exposes in-use owners", () => {
    const postMessage = vi.fn();
    window.vscodeApi = {
      postMessage,
      getState: () => undefined,
      setState: () => undefined,
    };
    useSettingsStore.getState().setWorktreeManagement({
      resolvedRoot: "C:/worktrees",
      sourceCheckoutRoot: "C:/repo",
      sourceCheckoutBranch: "main",
      generatedAt: Date.now(),
      staleManagedRecords: [],
      entries: [
        {
          worktreePath: "C:/worktrees/safe",
          headCommit: "a",
          branchName: "ctrlyoke/safe",
          ownership: "managed",
          branchState: "present",
          inUse: false,
          leaseOwners: [],
          stale: false,
          branchCleanupEligible: true,
        },
        {
          worktreePath: "C:/worktrees/live",
          headCommit: "b",
          branchName: "ctrlyoke/live",
          ownership: "managed",
          branchState: "present",
          inUse: true,
          leaseOwners: [
            {
              lease: { workflowKey: "wf", runRef: "run", stateRoot: "C:/repo" },
              ageMs: 1000,
            },
          ],
          stale: false,
          branchCleanupEligible: false,
        },
      ],
    });

    render(
      <WorktreesSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: "Clean up safe merged branches (1)" })
    ).toBeInTheDocument();
    expect(screen.getByText(/In use — wf\/run/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open owning workspace" })).toBeInTheDocument();
  });
  it("offers Sync only for a live, non-stale named worktree, not the source checkout itself", () => {
    const postMessage = vi.fn();
    window.vscodeApi = {
      postMessage,
      getState: () => undefined,
      setState: () => undefined,
    };
    window.confirm = vi.fn(() => true);
    useSettingsStore.getState().setWorktreeManagement({
      resolvedRoot: "C:/worktrees",
      sourceCheckoutRoot: "C:/repo",
      sourceCheckoutBranch: "main",
      generatedAt: Date.now(),
      staleManagedRecords: [],
      entries: [
        {
          worktreePath: "C:/repo",
          headCommit: "a",
          branchName: "main",
          ownership: "user",
          branchState: "present",
          inUse: false,
          leaseOwners: [],
          stale: false,
          branchCleanupEligible: false,
        },
        {
          worktreePath: "C:/repo.worktrees/bug-fix",
          headCommit: "b",
          branchName: "bug-fix",
          ownership: "user",
          branchState: "present",
          inUse: false,
          leaseOwners: [],
          stale: false,
          branchCleanupEligible: false,
        },
      ],
    });

    render(
      <WorktreesSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(
      screen.getAllByRole("button", { name: "Sync with main" })
    ).toHaveLength(1);

    screen.getByRole("button", { name: "Sync with main" }).click();
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SYNC_NAMED_WORKTREE,
      worktreePath: "C:/repo.worktrees/bug-fix",
    });
  });

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
