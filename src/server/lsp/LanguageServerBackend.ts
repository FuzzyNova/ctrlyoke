import type { MessageConnection } from "vscode-jsonrpc";
import { LSP_SESSION_LOOKUP_REASONS } from "../../types/DashboardConstants";
import type { WorkspacePathContext } from "./WorkspacePathContainment";

export const LANGUAGE_SERVER_RESOLUTION_REASONS = LSP_SESSION_LOOKUP_REASONS;

export type LanguageServerResolutionReason =
  (typeof LANGUAGE_SERVER_RESOLUTION_REASONS)[keyof typeof LANGUAGE_SERVER_RESOLUTION_REASONS];

export interface LanguageServerDescriptor {
  readonly id: string;
  readonly languageId: string;
  readonly rootPath: string;
  readonly capabilities: Record<string, unknown>;
  readonly serverInfo?: { name: string; version?: string };
}

export type LanguageServerResolution =
  | { readonly descriptor: LanguageServerDescriptor }
  | { readonly reason: LanguageServerResolutionReason };

/** Supplies initialized language-server connections to the shared host. */
export interface LanguageServerBackend {
  resolveForPath(
    viewerPath: string,
    roots: WorkspacePathContext
  ): Promise<LanguageServerResolution> | LanguageServerResolution;
  getConnection(
    descriptor: LanguageServerDescriptor
  ): Promise<MessageConnection> | MessageConnection;
}

/** Phase 1 production seam: no configured server can resolve yet. */
export class EmptyLanguageServerBackend implements LanguageServerBackend {
  resolveForPath(): LanguageServerResolution {
    return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
  }

  getConnection(): never {
    throw new Error("No language server is configured.");
  }
}
