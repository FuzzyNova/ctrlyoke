import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));
vi.mock("@hooks/useMessageHandler", () => ({ sendMessage: sendMessageMock }));

import { LanguageServersSection } from "@components/settings/LanguageServersSection";
import {
  useLanguageServerStore,
  LANGUAGE_SERVER_TABS,
} from "@store/useLanguageServerStore";
import {
  LANGUAGE_SERVER_STATUSES,
  MESSAGE_TYPES,
  SETTING_SCOPES,
} from "@/types/messages";
import type { LanguageServerCatalogEntry } from "@root/types/WebviewMessageTypes";
import { useSettingsStore } from "@store/settingsStore";

const catalog: LanguageServerCatalogEntry[] = [
  {
    id: "pyright",
    displayName: "Pyright",
    description: "Python",
    homepage: "https://example.test",
    license: "MIT",
    masonName: "pyright",
    command: ["pyright-langserver", "--stdio"],
    languages: ["python"],
    extensions: ["py"],
    rootMarkers: ["pyproject.toml"],
    install: { kind: "npm", packages: ["pyright"], bin: "pyright-langserver" },
  },
];

function seed(
  status?: (typeof LANGUAGE_SERVER_STATUSES)[keyof typeof LANGUAGE_SERVER_STATUSES]
) {
  useLanguageServerStore.setState({
    definitions:
      status === LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL
        ? [
            {
              id: "pyright",
              definition: {
                command: ["pyright-langserver", "--stdio"],
                languages: ["python"],
                extensions: ["py"],
                rootMarkers: ["pyproject.toml"],
              },
              scope: SETTING_SCOPES.WORKSPACE,
            },
          ]
        : [],
    catalog,
    probes: [
      {
        id: "pyright",
        detected: status !== LANGUAGE_SERVER_STATUSES.NOT_INSTALLED,
        ...(status !== LANGUAGE_SERVER_STATUSES.NOT_INSTALLED
          ? { resolvedPath: "/tools/pyright" }
          : {}),
      },
    ],
    statuses: status
      ? [
          {
            id: "pyright",
            rootPath: "/workspace",
            status,
            ...(status === LANGUAGE_SERVER_STATUSES.CRASHED
              ? { detail: "server failed: EPIPE" }
              : {}),
          },
        ]
      : [],
    detectedLanguages: ["python"],
    approvedWorkspaceDefinitionIds: [],
    localServers: [],
    localError: undefined,
    loading: false,
    scanning: false,
    query: "",
    tab: LANGUAGE_SERVER_TABS.CATALOG,
    installing: {},
    exportedTargets: {},
    exportResult: undefined,
  });
}

describe("LanguageServersSection", () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
    seed();
  });

  it.each(Object.values(LANGUAGE_SERVER_STATUSES))(
    "renders the %s status",
    (status) => {
      seed(status);
      render(<LanguageServersSection activeScope={SETTING_SCOPES.WORKSPACE} />);
      expect(
        screen.getByText(
          status === LANGUAGE_SERVER_STATUSES.NOT_INSTALLED
            ? "Not installed"
            : status === LANGUAGE_SERVER_STATUSES.LIMIT_REACHED
              ? "Limit reached"
              : status === LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL
                ? "Needs approval"
                : status[0]!.toUpperCase() + status.slice(1)
        )
      ).toBeTruthy();
      if (status === LANGUAGE_SERVER_STATUSES.CRASHED)
        expect(screen.getByTitle("server failed: EPIPE")).toBeTruthy();
    }
  );

  it("writes the selected language server to the active scope", () => {
    render(<LanguageServersSection activeScope={SETTING_SCOPES.USER} />);
    fireEvent.change(screen.getByLabelText("python language server"), {
      target: { value: "pyright" },
    });
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      {
        path: "languageServers.use.python",
        value: "pyright",
        scope: SETTING_SCOPES.USER,
      }
    );
  });

  it("shows Off for false selections and removes the active-scope override for Automatic", () => {
    const originalGlobalSettings = useSettingsStore.getState().globalSettings;
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        languageServers: { use: { python: false } },
      } as never,
    }));
    render(<LanguageServersSection activeScope={SETTING_SCOPES.USER} />);
    expect(
      (screen.getByLabelText("python language server") as HTMLSelectElement)
        .value
    ).toBe("off");
    fireEvent.change(screen.getByLabelText("python language server"), {
      target: { value: "auto" },
    });
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      {
        path: "languageServers.use.python",
        value: undefined,
        scope: SETTING_SCOPES.USER,
      }
    );
    useSettingsStore.setState({ globalSettings: originalGlobalSettings });
  });

  it("offers managed definitions in the detected language dropdown", () => {
    seed(LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL);
    render(<LanguageServersSection activeScope={SETTING_SCOPES.WORKSPACE} />);
    expect(
      screen.getByRole("option", { name: "pyright (managed)" })
    ).toBeTruthy();
  });

  it("keeps approved workspace definitions from showing an approval action", () => {
    seed(LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL);
    useLanguageServerStore.setState({
      approvedWorkspaceDefinitionIds: ["pyright"],
      statuses: [],
    });
    render(<LanguageServersSection activeScope={SETTING_SCOPES.WORKSPACE} />);
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("offers restart after a server was stopped by the user", () => {
    seed(LANGUAGE_SERVER_STATUSES.STOPPED);
    render(<LanguageServersSection activeScope={SETTING_SCOPES.WORKSPACE} />);
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("parses environment values at the first equals sign from a multiline field", () => {
    render(<LanguageServersSection activeScope={SETTING_SCOPES.USER} />);
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("id"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("command"), {
      target: { value: "custom-lsp --stdio" },
    });
    fireEvent.change(screen.getByLabelText("env"), {
      target: { value: "TOKEN=first=second\nMODE=fast" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.SAVE_LSP_DEFINITION,
      expect.objectContaining({
        id: "custom",
        definition: expect.objectContaining({
          env: { TOKEN: "first=second", MODE: "fast" },
        }),
        scope: SETTING_SCOPES.USER,
      })
    );
  });

  it("shows install errors and a copyable command in the catalog row", () => {
    useLanguageServerStore
      .getState()
      .setInstallProgress(
        "pyright",
        undefined,
        "npm failed",
        true,
        "npm install pyright"
      );
    render(<LanguageServersSection activeScope={SETTING_SCOPES.WORKSPACE} />);
    expect(screen.getByRole("alert").textContent).toContain("npm failed");
    expect(
      screen.getAllByRole("button", { name: "Copy install command" })
    ).toHaveLength(2);
  });

  it("exports a managed definition through the Save flyout", () => {
    seed(LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL);
    render(<LanguageServersSection activeScope={SETTING_SCOPES.WORKSPACE} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "User" }));
    fireEvent.click(screen.getByRole("button", { name: /Copilot CLI/ }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.EXPORT_LSP_DEFINITION,
      expect.objectContaining({
        id: "pyright",
        targetId: "copilot-user-lsp",
        scope: SETTING_SCOPES.USER,
      })
    );
  });

  it("marks a successfully exported target as Already exported", () => {
    seed(LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL);
    useLanguageServerStore.getState().setExportResult({
      id: "pyright",
      targetId: "copilot-user-lsp",
      scope: SETTING_SCOPES.USER,
      success: true,
    });
    render(<LanguageServersSection activeScope={SETTING_SCOPES.WORKSPACE} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "User" }));
    expect(screen.getByTitle(/Already exported/)).toBeTruthy();
  });

  it("sends npm installs to the host for authoritative confirmation", () => {
    seed(LANGUAGE_SERVER_STATUSES.NOT_INSTALLED);
    render(<LanguageServersSection activeScope={SETTING_SCOPES.WORKSPACE} />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.INSTALL_LSP_SERVER,
      { id: "pyright" }
    );
  });
});
