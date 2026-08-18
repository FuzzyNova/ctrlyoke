import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SecretsSection } from "@components/settings/SecretsSection";
import {
  SECRET_REGISTRY_STATES,
  SETTING_SCOPES,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import type { SecretRegistryEntry } from "@root/types/WebviewMessageTypes";
import { useSecretRegistryStore } from "@store/secretRegistryStore";

const postMessageSpy = vi.fn();

beforeEach(() => {
  useSecretRegistryStore.getState().resetSecretRegistry();
  (
    window.vscodeApi as unknown as { postMessage: ReturnType<typeof vi.fn> }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

function entry(
  name: string,
  state: SecretRegistryEntry["state"],
  overrides: Partial<SecretRegistryEntry> = {}
): SecretRegistryEntry {
  return {
    name,
    scope: SETTING_SCOPES.USER,
    state,
    usedBy: { mcpServers: [], workflows: [] },
    ...overrides,
  };
}

function setEntries(entries: SecretRegistryEntry[]) {
  useSecretRegistryStore.getState().setEntries(SETTING_SCOPES.USER, entries);
}

describe("SecretsSection", () => {
  it("renders the three registry states with their required action sets", () => {
    setEntries([
      entry("SERVICE_API_TOKEN", SECRET_REGISTRY_STATES.MANAGED_AND_SET, {
        lastUpdated: Date.now() - 3 * 86_400_000,
      }),
      entry(
        "GITHUB_TOKEN",
        SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_DETECTED
      ),
      entry(
        "STRIPE_KEY",
        SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_NOT_FOUND
      ),
    ]);

    render(<SecretsSection activeScope={SETTING_SCOPES.USER} />);

    const managed = within(screen.getByTestId("secret-row-SERVICE_API_TOKEN"));
    expect(managed.getByText(/Managed · set/)).toBeInTheDocument();
    expect(
      managed.getByRole("button", { name: "Replace" })
    ).toBeInTheDocument();
    expect(managed.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(
      managed.queryByRole("button", { name: "Convert to managed" })
    ).not.toBeInTheDocument();

    const detected = within(screen.getByTestId("secret-row-GITHUB_TOKEN"));
    expect(
      detected.getByText("From environment · detected")
    ).toBeInTheDocument();
    expect(
      detected.getByRole("button", { name: "Convert to managed" })
    ).toBeInTheDocument();
    expect(
      detected.getByRole("button", { name: "Remove declaration" })
    ).toBeInTheDocument();

    const missing = within(screen.getByTestId("secret-row-STRIPE_KEY"));
    expect(missing.getByText("From environment · not found")).toHaveClass(
      "text-warning-fg"
    );
    expect(
      missing.getByRole("button", { name: "Set value" })
    ).toBeInTheDocument();
    expect(
      missing.getByRole("button", { name: "Remove declaration" })
    ).toBeInTheDocument();
  });

  it("shows MCP and workflow usage without showing a value", async () => {
    const user = userEvent.setup();
    setEntries([
      entry("DEPLOY_TOKEN", SECRET_REGISTRY_STATES.MANAGED_AND_SET, {
        description: "Deployment credential",
        usedBy: {
          mcpServers: ["release-api"],
          workflows: ["deploy.ctrlyoke.yaml"],
        },
      }),
    ]);

    render(<SecretsSection activeScope={SETTING_SCOPES.USER} />);
    await user.click(screen.getByText("Used by (2)"));

    expect(screen.getByText("release-api")).toBeInTheDocument();
    expect(screen.getByText("deploy.ctrlyoke.yaml")).toBeInTheDocument();
    expect(screen.getByText("Deployment credential")).toBeInTheDocument();
    expect(screen.queryByText("secret-value")).not.toBeInTheDocument();
  });

  it("validates secret names and disables the name field on Replace", async () => {
    const user = userEvent.setup();
    setEntries([
      entry("EXISTING_TOKEN", SECRET_REGISTRY_STATES.MANAGED_AND_SET),
    ]);
    render(<SecretsSection activeScope={SETTING_SCOPES.USER} />);

    await user.click(screen.getByRole("button", { name: "Set secret" }));
    const nameInput = screen.getByLabelText("Name");
    await user.type(nameInput, "bad-name");
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Secret name must start with a capital letter and contain only capital letters, numbers, or underscores."
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(
      within(screen.getByTestId("secret-row-EXISTING_TOKEN")).getByRole(
        "button",
        { name: "Replace" }
      )
    );
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Name")).toHaveValue("EXISTING_TOKEN");
  });

  it("provides a masked multi-line textarea variant", async () => {
    const user = userEvent.setup();
    render(<SecretsSection activeScope={SETTING_SCOPES.USER} />);

    await user.click(screen.getByRole("button", { name: "Set secret" }));
    await user.click(
      screen.getByRole("checkbox", { name: /Multi-line value/i })
    );

    const valueField = screen.getByLabelText("Secret value (multi-line)");
    expect(valueField.tagName).toBe("TEXTAREA");
    expect(valueField).toHaveAttribute("autocomplete", "new-password");
  });

  it("clears component state after the one write submission and does not echo the value", async () => {
    const user = userEvent.setup();
    const secretValue = "line-one\nline-two-secret";
    render(<SecretsSection activeScope={SETTING_SCOPES.USER} />);

    await user.click(screen.getByRole("button", { name: "Set secret" }));
    await user.type(screen.getByLabelText("Name"), "NEW_TOKEN");
    await user.click(
      screen.getByRole("checkbox", { name: /Multi-line value/i })
    );
    await user.type(
      screen.getByLabelText("Secret value (multi-line)"),
      secretValue
    );
    await user.type(
      screen.getByLabelText(/Description/),
      "Temporary deploy token"
    );
    await user.click(screen.getByRole("button", { name: "Set value" }));

    const setMessages = postMessageSpy.mock.calls
      .map(([message]) => message as { type?: string; value?: string })
      .filter((message) => message.type === MESSAGE_TYPES.SET_SECRET);
    expect(setMessages).toHaveLength(1);
    expect(setMessages[0]).toMatchObject({
      name: "NEW_TOKEN",
      value: secretValue,
      description: "Temporary deploy token",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(secretValue);
    expect(JSON.stringify(useSecretRegistryStore.getState())).not.toContain(
      secretValue
    );
    expect(
      postMessageSpy.mock.calls.filter(([message]) => {
        const candidate = message as { type?: string };
        return candidate.type !== MESSAGE_TYPES.SET_SECRET;
      }).length
    ).toBeGreaterThan(0);
  });
});
