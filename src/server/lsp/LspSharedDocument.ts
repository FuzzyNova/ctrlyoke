import type { LspSessionProxy } from "./LspSessionProxy";

/** State shared by all browser tabs attached to one server document URI. */
export interface SharedDocument {
  readonly uri: string;
  readonly tabs: Map<LspSessionProxy, { text: string; version: number }>;
  serverVersion: number;
  syncedText?: string;
  syncedVersion?: number;
}
