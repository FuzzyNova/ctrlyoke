import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
}));

vi.mock("@hooks/useMessageHandler", () => ({
  sendMessage: sendMessageMock,
}));

import { McpManagerSection } from "@components/settings/McpManagerSection";
import {
  MCP_MANAGER_DISCOVERY_TABS,
  useMcpManagerStore,
} from "@store/useMcpManagerStore";
import { useSettingsStore } from "@store/settingsStore";
import {
  MESSAGE_TYPES,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
} from "@/types/messages";
import type {
  LocalMcpServerEntry,
  ManagedMcpServer,
} from "@root/types/WebviewMessageTypes";

function createManagedServer(id: string): ManagedMcpServer {
  return {
    id,
    displayName: id,
    config: {
      id,
      command: "npx",
      args: [id],
    },
    locations: [
      {
        targetId: SPECIAL_TARGET_IDS.CTRLYOKE,
        scope: SETTING_SCOPES.USER,
        path: `C:\\repo\\.ctrlyoke\\mcp\\${id}.json`,
      },
    ],
  };
}

const LOCAL_SERVERS: LocalMcpServerEntry[] = [
  {
    id: "server-a",
    source: "claude-user",
    path: "C:\\Users\\test\\.claude.json",
    command: "npx",
    args: ["server-a"],
  },
  {
    id: "server-b",
    source: "claude-user",
    path: "C:\\Users\\test\\.claude.json",
    command: "npx",
    args: ["server-b"],
  },
];

function renderSection(servers: ManagedMcpServer[]) {
  useSettingsStore
    .getState()
    .updateGlobalSetting("workspaceRoot", "C:\\repo\\ctrlyoke");
  useMcpManagerStore.setState({
    managedServers: servers,
    isLoadingRegistry: false,
    requestServers: vi.fn(),
    localServers: LOCAL_SERVERS,
    requestLocalScan: vi.fn(),
    isLoadingLocal: false,
    localError: undefined,
    remoteServers: undefined,
    isLoadingRemote: false,
    remoteError: undefined,
    remoteNextCursor: undefined,
    remotePageCursors: [undefined],
    remoteQuery: "",
    discoveryTab: MCP_MANAGER_DISCOVERY_TABS.LOCAL,
  });
  return render(<McpManagerSection activeScope={SETTING_SCOPES.USER} />);
}

describe("McpManagerSection", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    useSettingsStore.getState().resetSettings();
    useMcpManagerStore.setState({
      managedServers: [],
      isLoadingRegistry: false,
      requestServers: vi.fn(),
      localServers: [],
      requestLocalScan: vi.fn(),
      isLoadingLocal: false,
      localError: undefined,
      remoteServers: undefined,
      isLoadingRemote: false,
      remoteError: undefined,
      remoteNextCursor: undefined,
      remotePageCursors: [undefined],
      remoteQuery: "",
      discoveryTab: MCP_MANAGER_DISCOVERY_TABS.LOCAL,
    });
  });

  it("saves only selected servers to the ctrlyoke registry", async () => {
    const user = userEvent.setup();
    renderSection([
      createManagedServer("server-a"),
      createManagedServer("server-b"),
    ]);
    const bulkBar = screen.getByText(/Select all \(2\/2\)/).closest("div")!;

    sendMessageMock.mockClear();

    await user.click(screen.getByRole("checkbox", { name: "Select server-b" }));
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Save" })[0]
    );
    await user.click(
      within(bulkBar).getByRole("button", { name: "Claude Code" })
    );
    await user.click(screen.getByRole("button", { name: /ctrlyoke/ }));
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Save" })[1]
    );

    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.SAVE_MCP_REGISTRY_SERVER,
      {
        server: {
          id: "server-a",
          command: "npx",
          args: ["server-a"],
        },
        scope: SETTING_SCOPES.USER,
      }
    );
  });

  it("deletes only selected servers from the ctrlyoke registry", async () => {
    const user = userEvent.setup();
    renderSection([
      createManagedServer("server-a"),
      createManagedServer("server-b"),
    ]);
    const bulkBar = screen.getByText(/Select all \(2\/2\)/).closest("div")!;

    sendMessageMock.mockClear();

    await user.click(screen.getByRole("checkbox", { name: "Select server-b" }));
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Save" })[0]
    );
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    await user.click(deleteButtons[deleteButtons.length - 1]);
    await user.click(
      within(bulkBar).getByRole("button", { name: "Claude Code" })
    );
    await user.click(screen.getByRole("button", { name: /ctrlyoke/ }));
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Delete" })[1]
    );
    const confirmButtons = screen.getAllByRole("button", { name: "Delete" });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.DELETE_MCP_REGISTRY_SERVER,
      {
        id: "server-a",
        scope: SETTING_SCOPES.USER,
      }
    );
  });

  it("preserves non-visible default MCP entries when bulk set default runs", async () => {
    const user = userEvent.setup();
    useSettingsStore
      .getState()
      .updateGlobalSetting("mcpServers", [
        "legacy-server",
        { id: "server-b", command: "npx", args: ["server-b"] },
      ]);
    renderSection([
      createManagedServer("server-a"),
      createManagedServer("server-b"),
    ]);
    const bulkBar = screen.getByText(/Select all \(2\/2\)/).closest("div")!;

    sendMessageMock.mockClear();

    await user.click(screen.getByRole("checkbox", { name: "Select server-b" }));
    await user.click(
      within(bulkBar).getAllByRole("button", { name: "Save" })[0]
    );
    await user.click(screen.getByRole("button", { name: "Set Default" }));
    await user.click(screen.getByRole("button", { name: "Set as Default" }));

    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      {
        path: "defaults.mcpServers",
        value: [
          "legacy-server",
          { id: "server-a", command: "npx", args: ["server-a"] },
        ],
        scope: SETTING_SCOPES.USER,
      }
    );
  });
});
