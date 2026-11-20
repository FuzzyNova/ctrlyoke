import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultsPermissionsPage } from "@components/settings/defaults/DefaultsPermissionsPage";
import { SETTING_SCOPES } from "@/types/messages";
import {
  CAPABILITY_DOMAINS,
  HARNESS_IDS,
} from "@root/types/DashboardConstants";
import {
  PERMISSION_CAVEAT_CODES,
  type CapabilityDeclaration,
  type HarnessCapabilityRegistrySnapshot,
  type EffectivePermissionCapabilityState,
} from "@root/types/CompatibilityTypes";
import { useHarnessCapabilityStore } from "@store/harnessCapabilityStore";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

/** Unsupported harnesses mirror Codex: no allow list, a partial deny list. */
function createSnapshot(
  unsupportedHarnesses: readonly string[] = [HARNESS_IDS.CODEX_CLI]
): HarnessCapabilityRegistrySnapshot {
  const supported: EffectivePermissionCapabilityState = {
    mode: { fidelity: "exact", mechanism: "native", verification: "verified" },
    autoMode: {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "verified",
    },
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
    autoMode: {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "verified",
    },
    allowedTools: {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "verified",
    },
    deniedTools: {
      fidelity: "partial",
      mechanism: "native",
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

          autoMode: supportedDeclaration,
          allowedTools: unsupportedHarnesses.includes(harnessId)
            ? {
                fidelity: "unsupported",
                mechanism: "none",
                caveatCode: PERMISSION_CAVEAT_CODES.SANDBOX_APPROVAL_MODES,
              }
            : supportedDeclaration,
          deniedTools: supportedDeclaration,
        },
      },
      effective: {
        permissions: unsupportedHarnesses.includes(harnessId)
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
    useHarnessCapabilityStore
      .getState()
      .setCapabilitySnapshot(createSnapshot());
  });

  it("shows no support note when every harness enforces the tool lists", () => {
    useHarnessCapabilityStore
      .getState()
      .setCapabilitySnapshot(createSnapshot([]));
    render(
      <DefaultsPermissionsPage
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    expect(
      screen.queryByText(/currently supported by/)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/NOT ENFORCED/)).not.toBeInTheDocument();
  });

  it("warns only about the harness that ignores a list, with its own reason, while keeping both fields editable", () => {
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
      screen.queryByText(/currently supported by/)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Allowed Tools are NOT ENFORCED by the Codex harness because this harness has no allow list; its sandbox and approval modes decide what runs."
      )
    ).toBeInTheDocument();
    // Codex enforces MCP tool denials, so the deny list carries no warning.
    expect(screen.queryByText(/Denied Tools are/)).not.toBeInTheDocument();
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
