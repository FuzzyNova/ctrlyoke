import * as path from "path";
import { normalizeReferencePath } from "./ContextReferenceBuilder";
import {
  WORKSPACE_ENTRY_KINDS,
  type WorkspaceFileTreeEntryKind,
} from "../types/DashboardConstants";

export interface WorkspacePathEntry {
  readonly kind: WorkspaceFileTreeEntryKind;
  readonly relativePath: string;
  readonly lowerPath: string;
  readonly name: string;
  readonly lowerName: string;
  readonly parent: string;
  readonly lowerParent: string;
  /** Position in the store's stable discovery order. */
  readonly position: number;
}

/** Ordered, in-memory projection of workspace files and their directories. */
export class WorkspacePathStore {
  private filePaths: string[] = [];
  private pathEntries: WorkspacePathEntry[] = [];
  private currentVersion = 0;

  get version(): number {
    return this.currentVersion;
  }

  get entries(): readonly WorkspacePathEntry[] {
    return this.pathEntries;
  }

  get files(): readonly string[] {
    return this.filePaths;
  }

  replaceAll(paths: readonly string[]): void {
    this.filePaths = this.normalizeUnique(paths);
    this.rebuildEntries();
    this.currentVersion++;
  }

  add(pathValue: string | readonly string[]): void {
    const incoming = this.normalizeUnique(
      typeof pathValue === "string" ? [pathValue] : pathValue
    );
    const seen = new Set(this.filePaths);
    const added = incoming.filter((item) => !seen.has(item));
    if (added.length === 0) return;
    this.filePaths = [...this.filePaths, ...added];
    this.rebuildEntries();
    this.currentVersion++;
  }

  removeTree(pathValue: string): void {
    const normalized = normalizeReferencePath(pathValue).replace(/\/+$/, "");
    if (!normalized) return;
    const remaining = this.filePaths.filter(
      (item) => item !== normalized && !item.startsWith(`${normalized}/`)
    );
    if (remaining.length === this.filePaths.length) return;
    this.filePaths = remaining;
    this.rebuildEntries();
    this.currentVersion++;
  }

  private normalizeUnique(paths: readonly string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const raw of paths) {
      const item = normalizeReferencePath(raw);
      if (!item || item.startsWith("../") || seen.has(item)) continue;
      seen.add(item);
      normalized.push(item);
    }
    return normalized;
  }

  private rebuildEntries(): void {
    const directories = new Set<string>();
    const entries: WorkspacePathEntry[] = [];
    const append = (
      kind: WorkspaceFileTreeEntryKind,
      relativePath: string
    ): void => {
      const name = path.posix.basename(relativePath);
      const parent = path.posix.dirname(relativePath);
      entries.push({
        kind,
        relativePath,
        lowerPath: relativePath.toLowerCase(),
        name,
        lowerName: name.toLowerCase(),
        parent,
        lowerParent: parent.toLowerCase(),
        position: entries.length,
      });
    };
    for (const file of this.filePaths) {
      let parent = path.posix.dirname(file);
      while (parent !== "." && parent !== "" && !directories.has(parent)) {
        directories.add(parent);
        append(WORKSPACE_ENTRY_KINDS.DIRECTORY, parent);
        parent = path.posix.dirname(parent);
      }
      append(WORKSPACE_ENTRY_KINDS.FILE, file);
    }
    this.pathEntries = entries;
  }
}
