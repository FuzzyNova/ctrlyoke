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
