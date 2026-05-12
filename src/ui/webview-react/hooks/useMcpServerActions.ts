import { useCallback } from "react";
import type { McpServerConfig } from "@root/types/FlightPathTypes";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "../types/messages";
import { useVsCodeApi } from "./useVsCodeApi";

export function useMcpServerActions() {
  const vscode = useVsCodeApi();
  const {
    setMcpLocalServersLoading,
    setMcpRegistryLoading,
    setMcpWorkspaceServersLoading,
    setMcpWorkspaceServers,
  } = useUiStore();

  const handleRequestLocalServers = useCallback(() => {
    setMcpLocalServersLoading(true);
    vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_MCP_LOCAL_SERVERS });
  }, [setMcpLocalServersLoading, vscode]);

  const handleSearchRegistry = useCallback(
    (query: string, cursor?: string, updatedSince?: string) => {
      setMcpRegistryLoading(true);
      vscode.postMessage({
        type: MESSAGE_TYPES.REQUEST_MCP_REGISTRY,
        query,
        cursor,
        updatedSince,
      });
    },
    [setMcpRegistryLoading, vscode]
  );

  const handleRequestWorkspaceServers = useCallback(() => {
    setMcpWorkspaceServersLoading(true);
    vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_MCP_WORKSPACE_SERVERS });
  }, [setMcpWorkspaceServersLoading, vscode]);

  const handleWorkspaceServersChange = useCallback(
    (servers: McpServerConfig[]) => {
      setMcpWorkspaceServers(servers);
      vscode.postMessage({
        type: MESSAGE_TYPES.SAVE_MCP_WORKSPACE_SERVERS,
        servers,
      });
    },
    [setMcpWorkspaceServers, vscode]
  );

  return {
    handleRequestLocalServers,
    handleSearchRegistry,
    handleRequestWorkspaceServers,
    handleWorkspaceServersChange,
  };
}
