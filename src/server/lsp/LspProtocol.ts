export { LSP_METHODS } from "../../types/DashboardConstants";

export const LSP_VIEWER_URI_PREFIX = "file:///__ctrlyoke_workspace__/";
export const LSP_READ_ONLY_URI_SCHEME = "ctrlyoke-readonly:";

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
