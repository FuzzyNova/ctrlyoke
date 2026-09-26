import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreesSection } from "@components/settings/WorktreesSection";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type {
  FullGlobalSettings,
  WorktreeManagementEntry,
} from "@root/types/WebviewMessageTypes";
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
    expect(screen.queryByText(/Age:/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open owning workspace" })
    ).toBeInTheDocument();
  });
  it("offers Sync only for a live, non-stale named worktree, not the source checkout itself", () => {
    const postMessage = vi.fn();
    window.vscodeApi = {
      postMessage,
      getState: () => undefined,
      setState: () => undefined,
    };
    useSettingsStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, confirmResetOperations: true },
    }));
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

    // Sync is confirmed through the shared in-app modal, not window.confirm:
    // VS Code's webview iframe sandbox omits allow-modals, so native
    // confirm() resolves to false immediately with no dialog shown.
    fireEvent.click(screen.getByRole("button", { name: "Sync with main" }));
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.SYNC_NAMED_WORKTREE })
    );

    const modal = screen.getByRole("dialog");
    fireEvent.click(within(modal).getByRole("button", { name: "Sync" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SYNC_NAMED_WORKTREE,
      worktreePath: "C:/repo.worktrees/bug-fix",
      requestId: expect.any(String),
    });
  });

  it("Sync All merges every eligible branch forward then back, skipping a failure without aborting the chain", async () => {
    const postMessage = vi.fn();
    window.vscodeApi = {
      postMessage,
      getState: () => undefined,
      setState: () => undefined,
    };

    function makeEntry(
      worktreePath: string,
      branchName: string
    ): WorktreeManagementEntry {
      return {
        worktreePath,
        headCommit: "a",
        branchName,
        ownership: "user",
        branchState: "present",
        inUse: false,
        leaseOwners: [],
        stale: false,
        branchCleanupEligible: false,
      };
    }

    useSettingsStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, confirmResetOperations: true },
    }));
    useSettingsStore.getState().setWorktreeManagement({
      resolvedRoot: "C:/worktrees",
      sourceCheckoutRoot: "C:/repo",
      sourceCheckoutBranch: "main",
      generatedAt: Date.now(),
      staleManagedRecords: [],
      entries: [
        makeEntry("C:/repo", "main"),
        makeEntry("C:/repo.worktrees/branch-1", "branch-1"),
        makeEntry("C:/repo.worktrees/branch-2", "branch-2"),
        makeEntry("C:/repo.worktrees/branch-3", "branch-3"),
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

    fireEvent.click(screen.getByRole("button", { name: "Sync All with main" }));

    // Sync All is confirmed once through the shared modal (not once per
    // branch) before the chain runs.
    const modal = screen.getByRole("dialog");
    expect(modal).toHaveTextContent('Sync all 3 worktrees with "main"?');
    fireEvent.click(within(modal).getByRole("button", { name: "Sync All" }));

    // Forward pass over every eligible branch (display order), then a
    // reverse pass over all but the last so earlier branches pick up what
    // later branches only just merged into the source checkout.
    const expectedOrder = [
      "C:/repo.worktrees/branch-1",
      "C:/repo.worktrees/branch-2",
      "C:/repo.worktrees/branch-3",
      "C:/repo.worktrees/branch-2",
      "C:/repo.worktrees/branch-1",
    ];

    const syncCalls = () =>
      postMessage.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg.type === MESSAGE_TYPES.SYNC_NAMED_WORKTREE);

    for (let i = 0; i < expectedOrder.length; i++) {
      await waitFor(() => expect(syncCalls().length).toBeGreaterThan(i));
      const call = syncCalls()[i];
      expect(call.worktreePath).toBe(expectedOrder[i]);
      // Fail branch-2's forward-pass merge (a simulated conflict) to prove
      // it's skipped and reported rather than aborting the rest of the chain.
      const isBranch2Forward = i === 1;
      useSettingsStore.getState().setWorktreeActionResult(call.requestId, {
        success: !isBranch2Forward,
        message: isBranch2Forward ? "Merge conflict" : "up to date",
      });
    }

    expect(syncCalls()).toHaveLength(expectedOrder.length);
    await waitFor(() =>
      expect(
        screen.getByText('Synced 4 of 5 — "branch-2": Merge conflict')
      ).toBeInTheDocument()
    );
  });

  it("offers Remove/Force remove (not just Repair) for a stale managed entry whose directory Git never recorded as present", () => {
    useSettingsStore.getState().setWorktreeManagement({
      resolvedRoot: "C:/worktrees",
      sourceCheckoutRoot: "C:/repo",
      sourceCheckoutBranch: "main",
      generatedAt: Date.now(),
      staleManagedRecords: [],
      entries: [
        {
          worktreePath: "C:/worktrees/ghost",
          headCommit: "a",
          branchName: "ctrlyoke/ghost",
          ownership: "managed",
          directoryState: "missing",
          branchState: "present",
          inUse: false,
          leaseOwners: [],
          stale: true,
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

    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Force remove" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Repair entry" })
    ).toBeInTheDocument();
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

    expect(
      screen.getByLabelText("Worktree root, property worktrees.root")
    ).toBeDisabled();
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
