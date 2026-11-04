import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultsPermissionsPage } from "@components/settings/defaults/DefaultsPermissionsPage";
import { SETTING_SCOPES } from "@/types/messages";
import {
  CAPABILITY_DOMAINS,
  HARNESS_IDS,
} from "@root/types/DashboardConstants";
import type {
  CapabilityDeclaration,
  HarnessCapabilityRegistrySnapshot,
  EffectivePermissionCapabilityState,
} from "@root/types/CompatibilityTypes";
import { useCompatibilityStore } from "@store/compatibilityStore";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function createSnapshot(): HarnessCapabilityRegistrySnapshot {
  const supported: EffectivePermissionCapabilityState = {
    mode: { fidelity: "exact", mechanism: "native", verification: "verified" },
    allowedTools: {
      fidelity: "exact",
      mechanism: "translated-cli",
      verification: "verified",
    },
    deniedTools: {
      fidelity: "exact",
      mechanism: "translated-cli",
      verification: "verified",
    },
  };
  const unsupported: EffectivePermissionCapabilityState = {
    mode: { fidelity: "exact", mechanism: "native", verification: "verified" },
    allowedTools: {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "verified",
    },
    deniedTools: {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "verified",
    },
  };
  const supportedDeclaration: CapabilityDeclaration = {
    fidelity: "exact",
    mechanism: "translated-cli",
  };
  const harnesses = {} as HarnessCapabilityRegistrySnapshot["harnesses"];
  for (const harnessId of Object.values(HARNESS_IDS)) {
    harnesses[harnessId] = {
      available: true,
      descriptor: {
        harnessId,
        permissions: {
          mode: supportedDeclaration,
          allowedTools: supportedDeclaration,
          deniedTools: supportedDeclaration,
        },
      },
      effective: {
        permissions:
          harnessId === HARNESS_IDS.CODEX_CLI ||
          harnessId === HARNESS_IDS.ANTIGRAVITY_CLI
            ? unsupported
            : supported,
      },
    };
  }

  return {
    schemaVersion: 1,
    enabledDomains: [CAPABILITY_DOMAINS.PERMISSIONS],
    harnesses,
  };
}

function createSettings(): FullGlobalSettings {
  return {
    settings: CTRLYOKE_SETTINGS_DEFAULTS,
    sources: {},
    isMultiRoot: false,
  };
}

describe("DefaultsPermissionsPage compatibility summary", () => {
  beforeEach(() => {
    useCompatibilityStore.getState().setCapabilitySnapshot(createSnapshot());
  });

  it("summarizes supported and mode-only harnesses while keeping both fields editable", () => {
    render(
      <DefaultsPermissionsPage
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    expect(
      screen.getByRole("textbox", { name: "Allowed tools (one per line)" })
    ).not.toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Denied tools (one per line)" })
    ).not.toBeDisabled();
    expect(
      screen.getByText(
        "Allowed Tools are currently supported by Copilot CLI, Claude CLI, OpenCode, and Qwen Code."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Codex and Antigravity CLI only support an overall permission mode, not individual tool patterns; Allowed Tools are NOT ENFORCED by these harnesses."
      )
    ).toBeInTheDocument();
  });

  it("renders the default sandbox and sandbox mode settings", () => {
    render(
      <DefaultsPermissionsPage
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    expect(screen.queryByText("Codex sandbox")).not.toBeInTheDocument();
    // Off is the shipped default.
    expect(
      screen.getByRole("button", { name: /property defaults\.sandbox$/ })
    ).toHaveTextContent("Off");
    expect(
      screen.getByRole("button", { name: /property defaults\.sandboxMode$/ })
    ).toHaveTextContent("Workspace write");
  });

  it("writes On, Off and None", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onReset = vi.fn();
    render(
      <DefaultsPermissionsPage
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={onReset}
      />
    );
    const choose = async (label: string) => {
      await user.click(
        screen.getByRole("button", { name: /property defaults\.sandbox$/ })
      );
      // Match the option, not the trigger ("<value>, property …") or the
      // approval policy's "On Request".
      const option = screen
        .getAllByRole("button", { name: new RegExp(`^${label}\\b`) })
        .find(
          (element) =>
            !/property|Request/.test(
              element.getAttribute("aria-label") ?? element.textContent ?? ""
            )
        );
      expect(option, label).toBeDefined();
      await user.click(option!);
    };

    await choose("On");
    expect(onUpdate).toHaveBeenLastCalledWith("defaults.sandbox", true);
    await choose("Off");
    expect(onUpdate).toHaveBeenLastCalledWith("defaults.sandbox", false);
    await choose("None");
    expect(onUpdate).toHaveBeenLastCalledWith("defaults.sandbox", null);
    expect(onReset).not.toHaveBeenCalled();
  });
});
