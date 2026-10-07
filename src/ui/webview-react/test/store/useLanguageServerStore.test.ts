import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));
vi.mock("@hooks/useMessageHandler", () => ({ sendMessage: sendMessageMock }));

import { MESSAGE_TYPES, SETTING_SCOPES } from "@/types/messages";
import {
  useLanguageServerStore,
  LANGUAGE_SERVER_TABS,
} from "@store/useLanguageServerStore";

describe("useLanguageServerStore", () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
    useLanguageServerStore.setState({
      definitions: [],
      catalog: [],
      probes: [],
      statuses: [],
      localServers: [],
      localError: undefined,
      loading: false,
      scanning: false,
      query: "",
      tab: LANGUAGE_SERVER_TABS.CATALOG,
      installing: {},
    });
  });

  it("requests server data and local scans", () => {
    useLanguageServerStore.getState().requestServers();
    useLanguageServerStore.getState().requestLocalScan();
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      1,
      MESSAGE_TYPES.REQUEST_LSP_SERVERS
    );
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      2,
      MESSAGE_TYPES.REQUEST_LSP_LOCAL_SCAN
    );
    expect(useLanguageServerStore.getState().loading).toBe(true);
    expect(useLanguageServerStore.getState().scanning).toBe(true);
  });

  it("stores server updates and install progress", () => {
    useLanguageServerStore
      .getState()
      .setServers({ definitions: [], catalog: [], probes: [], statuses: [] });
    useLanguageServerStore
      .getState()
      .setInstallProgress("pyright", "Downloading");
    expect(useLanguageServerStore.getState().installing.pyright).toBe(
      "Downloading"
    );
    useLanguageServerStore
      .getState()
      .setInstallProgress("pyright", undefined, undefined, true);
    expect(
      useLanguageServerStore.getState().installing.pyright
    ).toBeUndefined();
  });

  it("sends scoped definition and lifecycle actions", () => {
    const definition = {
      command: ["server", "--stdio"],
      languages: ["x"],
      extensions: ["x"],
      rootMarkers: [],
    };
    useLanguageServerStore
      .getState()
      .saveDefinition("x", definition, SETTING_SCOPES.USER);
    useLanguageServerStore
      .getState()
      .deleteDefinition("x", SETTING_SCOPES.USER);
    useLanguageServerStore.getState().install("x");
    useLanguageServerStore.getState().restart("x");
    useLanguageServerStore.getState().stop("x");
    useLanguageServerStore.getState().requestApproval();
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      1,
      MESSAGE_TYPES.SAVE_LSP_DEFINITION,
      { id: "x", definition, scope: SETTING_SCOPES.USER }
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.DELETE_LSP_DEFINITION,
      { id: "x", scope: SETTING_SCOPES.USER }
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.INSTALL_LSP_SERVER,
      { id: "x" }
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.RESTART_LSP_SERVER,
      { id: "x" }
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.STOP_LSP_SERVER,
      { id: "x" }
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      MESSAGE_TYPES.REQUEST_LSP_APPROVAL
    );
  });
});
