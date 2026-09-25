import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionSection } from "@components/settings/ExecutionSection";
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

describe("ExecutionSection", () => {
  it("leaves execution mode in the defaults page", () => {
    render(
      <ExecutionSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    expect(screen.queryByText("Execution mode")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(
        /^Max prompt timeout \(seconds, -1 = unlimited\), property execution\.maxPromptTimeout$/
      )
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "Context resolution failures, property execution.contextResolutionFailure"
      )
    ).toHaveValue("warn");
  });
});
