import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitSection } from "@components/settings/CommitSection";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function createSettings(): FullGlobalSettings {
  return {
    settings: CTRLYOKE_SETTINGS_DEFAULTS,
    sources: {},
    isMultiRoot: false,
  };
}

describe("CommitSection", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      lastCommitMessageGeneration: null,
    });
    useUiStore.setState({
      globalSettingsOpen: true,
      outputCollapsed: true,
      activeWorkflowId: null,
      activeOutputTabs: {},
      displayedViewAddress: null,
      appliedViewAddress: null,
      pendingRunViewRequestId: null,
    });
    (window.vscodeApi?.postMessage as ReturnType<typeof vi.fn>).mockClear();
  });

  it("does not auto-request a preview on mount", () => {
    render(
      <CommitSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    expect(
      screen.getByText("No commit message generation has run yet.")
    ).toBeInTheDocument();
  });

  it("renders the last real generation input from the settings store", () => {
    render(
      <CommitSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    act(() => {
      useSettingsStore.getState().setLastCommitMessageGeneration({
        source: "workspace-viewer",
        workingDirectory: "c:\\dev\\ctrlyoke",
        commands: ["git diff --cached", "git diff"],
        output: "diff --git a/src/foo.ts b/src/foo.ts",
        staged: false,
        truncated: true,
        includesUntrackedFiles: true,
        generatedAt: Date.UTC(2026, 4, 10, 12, 0, 0),
      });
    });

    expect(
      screen.getByText("Last triggered from: Workspace viewer")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === "git diff --cached\ngit diff"
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/c:\\dev\\ctrlyoke/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Used working tree diff plus generated hunks for untracked files."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("The diff was truncated before being sent to the AI.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("diff --git a/src/foo.ts b/src/foo.ts")
    ).toBeInTheDocument();
  });

  it("navigates to the persisted generation output", () => {
    render(
      <CommitSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    act(() => {
      useSettingsStore.getState().setLastCommitMessageGeneration({
        source: "scm",
        workingDirectory: "c:\\dev\\ctrlyoke",
        commands: [],
        output: "diff",
        staged: true,
        truncated: false,
        includesUntrackedFiles: false,
        generatedAt: Date.now(),
        workflowKey: "commit-message-generation-20260824-120000",
        runRef: "run-20260824-120000",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "View full output" }));

    expect(useUiStore.getState().globalSettingsOpen).toBe(false);
    expect(useUiStore.getState().outputCollapsed).toBe(false);
    expect(
      useUiStore.getState().activeOutputTabs[
        "commit-message-generation-20260824-120000"
      ]
    ).toBe("output");
    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.LOAD_RUN_VIEW,
      address: {
        kind: "run",
        workflowKey: "commit-message-generation-20260824-120000",
        runRef: "run-20260824-120000",
      },
      requestId: expect.any(String),
    });
  });
});
