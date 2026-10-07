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
  /** Called by the shared host once it has installed its request handlers. */
  listenConnection?(connection: MessageConnection): void;
  /** Lifecycle accounting used by managed backends to protect open buffers. */
  documentOpened?(descriptor: LanguageServerDescriptor): void;
  documentClosed?(descriptor: LanguageServerDescriptor): void;
  /** Optional eager start for the host's detected languages. */
  startLanguages?(languageIds: readonly string[]): Promise<void>;
  restartServer?(id: string): Promise<void>;
  requestWorkspaceApproval?(): Promise<boolean>;
  stopManagedServer?(id: string): Promise<void>;
  dispose?(): void | Promise<void>;
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
