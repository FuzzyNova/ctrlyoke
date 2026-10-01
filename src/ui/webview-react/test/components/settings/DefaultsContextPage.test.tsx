import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DefaultsContextPage } from "@components/settings/defaults/DefaultsContextPage";
import { SETTING_SCOPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { PriorContext } from "@root/types/CtrlYokeTypes";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function renderPage(priorContext: PriorContext, onUpdate = vi.fn()) {
  const settings: FullGlobalSettings = {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      defaults: { ...CTRLYOKE_SETTINGS_DEFAULTS.defaults, priorContext },
    },
    sources: {},
    isMultiRoot: false,
  };
  render(
    <DefaultsContextPage
      settings={settings}
      activeScope={SETTING_SCOPES.USER}
      onUpdate={onUpdate}
      onReset={() => {}}
    />
  );
  return onUpdate;
}

describe("DefaultsContextPage prior context", () => {
  it("shows a Previous N default as itself rather than None", () => {
    renderPage({ previous: 3 });
    expect(
      screen.getByRole("button", { name: /^Previous 3,/ })
    ).toBeInTheDocument();
  });

  it("shows a Custom range default with its range", () => {
    renderPage([1, 2, 4]);
    expect(
      screen.getByRole("button", { name: /^Custom,/ })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Custom step range/)).toHaveValue("1-2,4");
  });

  it("does not offer a run address, which settings cannot store", () => {
    renderPage("none");
    fireEvent.click(screen.getByRole("button", { name: /^None,/ }));
    expect(
      screen.queryByRole("button", { name: /Completed run output/ })
    ).not.toBeInTheDocument();
  });

  it("writes none when a custom range is cleared", () => {
    const onUpdate = renderPage([2]);
    fireEvent.change(screen.getByLabelText(/Custom step range/), {
      target: { value: "" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith("defaults.priorContext", "none");
  });
});
