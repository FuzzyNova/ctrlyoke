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
  private fileSet = new Set<string>();
  private directorySet = new Set<string>();
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
    this.reset();
    this.appendNew(paths);
    this.currentVersion++;
  }

  /**
   * Append paths not already present. Existing entries keep their positions,
   * so this costs only the new paths, not the size of the store.
   */
  add(pathValue: string | readonly string[]): void {
    const added = this.appendNew(
      typeof pathValue === "string" ? [pathValue] : pathValue
    );
    if (added > 0) this.currentVersion++;
  }

  removeTree(pathValue: string): void {
    this.removeTrees([pathValue]);
  }

  /**
   * Remove each path and everything beneath it in one pass. Directories left
   * without files disappear, because entries are re-derived from the files.
   */
  removeTrees(pathValues: readonly string[]): void {
    const targets = pathValues
      .map((value) => normalizeReferencePath(value).replace(/\/+$/, ""))
      .filter(Boolean);
    if (targets.length === 0) return;
    const prefixes = targets.map((target) => `${target}/`);
    const removed = (item: string): boolean =>
      targets.includes(item) ||
      prefixes.some((prefix) => item.startsWith(prefix));
    const remaining = this.filePaths.filter((item) => !removed(item));
    if (remaining.length === this.filePaths.length) return;
    this.reset();
    this.appendNew(remaining);
    this.currentVersion++;
  }

  private reset(): void {
    this.filePaths = [];
    this.fileSet = new Set();
    this.directorySet = new Set();
    this.pathEntries = [];
  }

  /** Appends unseen files (and their unseen parent directories) in order. */
  private appendNew(paths: readonly string[]): number {
    let added = 0;
    for (const raw of paths) {
      const file = normalizeReferencePath(raw);
      if (!file || file.startsWith("../") || this.fileSet.has(file)) continue;
      this.fileSet.add(file);
      this.filePaths.push(file);
      // A directory is listed where its first file is rather than after them
      // all, because store order breaks ranking ties.
      let parent = path.posix.dirname(file);
      while (
        parent !== "." &&
        parent !== "" &&
        !this.directorySet.has(parent)
      ) {
        this.directorySet.add(parent);
        this.append(WORKSPACE_ENTRY_KINDS.DIRECTORY, parent);
        parent = path.posix.dirname(parent);
      }
      this.append(WORKSPACE_ENTRY_KINDS.FILE, file);
      added++;
    }
    return added;
  }

  private append(kind: WorkspaceFileTreeEntryKind, relativePath: string): void {
    const name = path.posix.basename(relativePath);
    const parent = path.posix.dirname(relativePath);
    this.pathEntries.push({
      kind,
      relativePath,
      lowerPath: relativePath.toLowerCase(),
      name,
      lowerName: name.toLowerCase(),
      parent,
      lowerParent: parent.toLowerCase(),
      position: this.pathEntries.length,
    });
  }
}
