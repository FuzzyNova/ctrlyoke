import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CommitSection } from "@components/settings/CommitSection";
import { useSettingsStore } from "@store/settingsStore";
import { SETTING_SCOPES } from "@/types/messages";
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
});
