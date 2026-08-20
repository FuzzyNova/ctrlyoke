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
  it("renders configured external file roots in the textarea", () => {
    render(
      <AdvancedPermissionsSection
        settings={createSettings({
          allowedExternalFileRoots: ["/home/user/logs", "/var/log/my-tool"],
        })}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    const textarea = screen.getByRole("textbox", {
      name: /Allowed external directories/i,
    }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("/home/user/logs\n/var/log/my-tool");
  });

  it("commits parsed, trimmed lines on blur", async () => {
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

    const textarea = screen.getByRole("textbox", {
      name: /Allowed external directories/i,
    });
    await user.click(textarea);
    await user.paste("/home/user/logs\n  /var/log/my-tool  \n");
    await user.tab();

    expect(onUpdate).toHaveBeenCalledWith(
      "permissions.allowedExternalFileRoots",
      ["/home/user/logs", "/var/log/my-tool"]
    );
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

  it("reflects the heuristic secret redaction setting and calls onUpdate on toggle", async () => {
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
      name: /Heuristic secret redaction/i,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(
      CTRLYOKE_SETTINGS_DEFAULTS.permissions.heuristicSecretRedactionEnabled
    );

    await user.click(checkbox);

    expect(onUpdate).toHaveBeenCalledWith(
      "permissions.heuristicSecretRedactionEnabled",
      !CTRLYOKE_SETTINGS_DEFAULTS.permissions.heuristicSecretRedactionEnabled
    );
  });
});
