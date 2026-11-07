import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));
vi.mock("@hooks/useMessageHandler", () => ({ sendMessage: sendMessageMock }));

import { MESSAGE_TYPES, SETTING_SCOPES } from "@/types/messages";
import { useMcpManagerStore } from "@store/useMcpManagerStore";

describe("useMcpManagerStore", () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
    useMcpManagerStore.setState({
      managedServers: undefined,
      isLoadingRegistry: false,
      activeScope: SETTING_SCOPES.WORKSPACE,
      localServers: [],
      isLoadingLocal: false,
      localError: undefined,
      userConfigPaths: {},
      remoteServers: undefined,
      isLoadingRemote: false,
      remoteError: undefined,
      remoteNextCursor: undefined,
      remotePageCursors: [undefined],
      remoteQuery: "",
      latestRemoteRequestId: 0,
      remoteSort: "a-z",
      discoveryTab: "local",
    });
  });

  it("keeps the last reported user config paths when a scan omits them", () => {
    const paths = { "copilot-cli": "D:/alt/copilot/mcp-config.json" } as const;
    useMcpManagerStore.getState().setLocalScanResult([], undefined, paths);
    expect(useMcpManagerStore.getState().userConfigPaths).toEqual(paths);

    useMcpManagerStore.getState().setLocalScanResult([], "scan failed");
    expect(useMcpManagerStore.getState().userConfigPaths).toEqual(paths);
  });

  it("ignores stale registry replies and keeps the latest cursor", () => {
    const store = useMcpManagerStore.getState();
    store.searchRemoteRegistry("git");
    store.searchRemoteRegistry("github");
    const [, firstRequest] = sendMessageMock.mock.calls[0]!;
    const [, secondRequest] = sendMessageMock.mock.calls[1]!;

    useMcpManagerStore
      .getState()
      .setRemoteSearchResult(
        firstRequest.requestId,
        [{ id: "old", name: "Old", description: "" }],
        undefined,
        "old-cursor"
      );
    expect(useMcpManagerStore.getState().remoteServers).toBeUndefined();

    useMcpManagerStore
      .getState()
      .setRemoteSearchResult(
        secondRequest.requestId,
        [{ id: "current", name: "Current", description: "" }],
        undefined,
        "current-cursor"
      );
    expect(useMcpManagerStore.getState().remoteServers?.[0]?.id).toBe(
      "current"
    );
    expect(useMcpManagerStore.getState().remoteNextCursor).toBe(
      "current-cursor"
    );
  });

  it("includes request ids for page requests", () => {
    useMcpManagerStore.getState().searchRemoteRegistry("github");
    useMcpManagerStore
      .getState()
      .setRemoteSearchResult(1, [], undefined, "next");
    useMcpManagerStore.getState().goNextPage();
    expect(sendMessageMock).toHaveBeenLastCalledWith(
      MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SEARCH,
      expect.objectContaining({ query: "github", cursor: "next", requestId: 2 })
    );
  });
});
