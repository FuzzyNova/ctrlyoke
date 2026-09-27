import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdvancedPermissionsSection } from "@components/settings/AdvancedPermissionsSection";
import { SETTING_SCOPES, MESSAGE_TYPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

// The vscode mock is set up in test/setup.ts (window.vscodeApi).
const postMessageSpy = vi.fn();

beforeEach(() => {
  (
    window.vscodeApi as unknown as { postMessage: ReturnType<typeof vi.fn> }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

function createSettings(
  overrides?: Partial<typeof CTRLYOKE_SETTINGS_DEFAULTS.permissions>
): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      permissions: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.permissions,
        ...overrides,
      },
    },
    sources: {},
    isMultiRoot: false,
  };
}

describe("AdvancedPermissionsSection — allowed external file roots", () => {
  it("renders user-scope roots without decision status controls", () => {
    render(
      <AdvancedPermissionsSection
        settings={createSettings({
          trustedExternalRoots: ["/home/user/logs", "/var/log/my-tool"],
        })}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    expect(screen.getByText("/home/user/logs")).toBeInTheDocument();
    expect(screen.getByText("/var/log/my-tool")).toBeInTheDocument();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Allow /i })
    ).not.toBeInTheDocument();
  });

  it("adds a trimmed manual path through the shared editor", async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedPermissionsSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => {}}
      />
    );

    await user.type(
      screen.getByRole("textbox", { name: /External directory path/i }),
      "  /home/user/logs  "
    );
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(onUpdate).toHaveBeenCalledWith("permissions.trustedExternalRoots", [
      "/home/user/logs",
    ]);
  });

  it("shows workspace decisions and posts decision changes without editing the request list", async () => {
    const user = userEvent.setup();
    render(
      <AdvancedPermissionsSection
        settings={{
          ...createSettings({ trustedExternalRoots: ["/shared/logs"] }),
          externalFileRootsByScope: {
            user: [],
            workspace: [{ path: "/shared/logs", decision: "deny" }],
          },
        }}
        activeScope={SETTING_SCOPES.WORKSPACE}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    expect(screen.getByText("Denied")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Allow /shared/logs" })
    );

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.UPDATE_EXTERNAL_ROOT_DECISION,
      scope: SETTING_SCOPES.WORKSPACE,
      path: "/shared/logs",
      decision: "allow",
    });
  });

  it("posts BROWSE_AND_ADD_EXTERNAL_ROOT with the active scope when 'Add folder…' is clicked", async () => {
    const user = userEvent.setup();
    render(
      <AdvancedPermissionsSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.WORKSPACE}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    await user.click(screen.getByRole("button", { name: /Add folder/i }));

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.BROWSE_AND_ADD_EXTERNAL_ROOT,
      scope: SETTING_SCOPES.WORKSPACE,
    });
  });

  it("reflects the offerTrustForUntrustedFileLinks setting and calls onUpdate on toggle", async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();
    render(
      <AdvancedPermissionsSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => {}}
      />
    );

    const checkbox = screen.getByRole("checkbox", {
      name: /Offer trust for untrusted file links/i,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(
      CTRLYOKE_SETTINGS_DEFAULTS.ui.offerTrustForUntrustedFileLinks
    );

    await user.click(checkbox);

    expect(onUpdate).toHaveBeenCalledWith(
      "ui.offerTrustForUntrustedFileLinks",
      !CTRLYOKE_SETTINGS_DEFAULTS.ui.offerTrustForUntrustedFileLinks
    );
  });
});
