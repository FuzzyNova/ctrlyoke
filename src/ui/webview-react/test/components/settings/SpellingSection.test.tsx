import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpellingSection } from "@components/settings/SpellingSection";
import {
  SETTING_PATHS,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function settings(
  spellingWordsByScope: FullGlobalSettings["spellingWordsByScope"]
): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      spelling: { enabled: true, words: ["ctrlyoke", "teamword"] },
    },
    sources: {},
    spellingWordsByScope,
    isMultiRoot: false,
  };
}

function renderSection(activeScope: SettingWriteScope, onUpdate = vi.fn()) {
  render(
    <SpellingSection
      settings={settings({ user: ["ctrlyoke"], workspace: ["teamword"] })}
      activeScope={activeScope}
      onUpdate={onUpdate}
      onReset={() => undefined}
    />
  );
  return onUpdate;
}

describe("SpellingSection", () => {
  it("edits only the active scope's own words, not the merged union", () => {
    const onUpdate = renderSection("workspace");

    expect(screen.getByTestId("spelling-word-teamword")).toBeInTheDocument();
    expect(
      screen.queryByTestId("spelling-word-ctrlyoke")
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Custom word"), {
      target: { value: "  frobnicate " },
    });
    fireEvent.submit(screen.getByLabelText("Custom word").closest("form")!);
    expect(onUpdate).toHaveBeenCalledWith(SETTING_PATHS.SPELLING_WORDS, [
      "teamword",
      "frobnicate",
    ]);
  });

  it("removes a word from the user list", () => {
    const onUpdate = renderSection("user");
    fireEvent.click(screen.getByLabelText("Remove word ctrlyoke"));
    expect(onUpdate).toHaveBeenCalledWith(SETTING_PATHS.SPELLING_WORDS, []);
  });

  it("rejects a word with spaces and a duplicate", () => {
    const onUpdate = renderSection("user");
    const input = screen.getByLabelText("Custom word");

    fireEvent.change(input, { target: { value: "two words" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A word cannot contain spaces."
    );

    fireEvent.change(input, { target: { value: "ctrlyoke" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent(
      '"ctrlyoke" is already in the list.'
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("toggles spell check", () => {
    const onUpdate = renderSection("user");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Check spelling in the prompt editor/,
      })
    );
    expect(onUpdate).toHaveBeenCalledWith(
      SETTING_PATHS.SPELLING_ENABLED,
      false
    );
  });
});
