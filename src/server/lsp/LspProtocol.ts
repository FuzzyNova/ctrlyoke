export { LSP_METHODS } from "../../types/DashboardConstants";
export { LSP_VIEWER_URI_PREFIX } from "../../types/HostedWorkspaceViewerTypes";
import { LSP_VIEWER_URI_PREFIX } from "../../types/HostedWorkspaceViewerTypes";
export const LSP_READ_ONLY_URI_SCHEME = "ctrlyoke-readonly:";

export function toLspViewerUri(viewerPath: string): string {
  return `${LSP_VIEWER_URI_PREFIX}${viewerPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export function fromLspViewerUri(uri: string): string | undefined {
  if (!uri.startsWith(LSP_VIEWER_URI_PREFIX)) return undefined;
  try {
    return uri
      .slice(LSP_VIEWER_URI_PREFIX.length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
  } catch {
    return undefined;
  }
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;
