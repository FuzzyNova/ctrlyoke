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

/**
 * Estimated heap cost of one entry beyond its path characters: the string
 * headers, the column slots and the dedupe-set slot. Measured with
 * `--expose-gc` over a real repository's paths; it only has to be close
 * enough to keep the index well under its worker's heap limit.
 */
const ENTRY_OVERHEAD_BYTES = 72;
const KIND_FILE = 0;
const KIND_DIRECTORY = 1;
const INITIAL_CAPACITY = 1024;

/** A path, its lowercase form (counted even when shared) and its overhead. */
function entryBytes(relativePath: string): number {
  return ENTRY_OVERHEAD_BYTES + 2 * relativePath.length;
}

/**
 * Ordered, in-memory projection of workspace files and their directories.
 *
 * Stored as columns rather than one object per entry, because the index can
 * hold millions of paths: the lowercase path shares the original string when
 * they are equal, and name and parent are offsets into the path. Queries scan
 * the columns and build a {@link WorkspacePathEntry} only for candidates.
 */
export class WorkspacePathStore {
  private paths: string[] = [];
  private lowerPaths: string[] = [];
  private kinds = new Uint8Array(INITIAL_CAPACITY);
  /** Index in the path where the name starts (0 for a top-level entry). */
  private nameStarts = new Uint32Array(INITIAL_CAPACITY);
  private fileSet = new Set<string>();
  private directorySet = new Set<string>();
  private currentVersion = 0;
  private bytes = 0;

  /** Heap estimate, in bytes, of the same paths held in a store. */
  static estimateBytes(paths: readonly string[]): number {
    let total = 0;
    for (const item of paths) total += entryBytes(item);
    return total;
  }

  get version(): number {
    return this.currentVersion;
  }

  /** Number of entries, files and directories together. */
  get size(): number {
    return this.paths.length;
  }

  get fileCount(): number {
    return this.fileSet.size;
  }

  /** Heap estimate of everything the store holds. */
  get estimatedBytes(): number {
    return this.bytes;
  }

  /** Files in store order. Allocates; for tests and rare rewrites only. */
  get files(): string[] {
    return this.paths.filter((_, i) => this.kinds[i] === KIND_FILE);
  }

  kindAt(position: number): WorkspaceFileTreeEntryKind {
    return this.kinds[position] === KIND_FILE
      ? WORKSPACE_ENTRY_KINDS.FILE
      : WORKSPACE_ENTRY_KINDS.DIRECTORY;
  }

  isFileAt(position: number): boolean {
    return this.kinds[position] === KIND_FILE;
  }

  pathAt(position: number): string {
    return this.paths[position];
  }

  lowerPathAt(position: number): string {
    return this.lowerPaths[position];
  }

  lowerNameAt(position: number): string {
    return this.lowerPaths[position].slice(this.nameStarts[position]);
  }

  /** True when the entry's parent is `parent` ("." for the root). */
  hasParent(position: number, parent: string): boolean {
    return this.parentIs(this.paths[position], position, parent);
  }

  /** {@link hasParent} against the lowercase path. */
  hasLowerParent(position: number, lowerParent: string): boolean {
    return this.parentIs(this.lowerPaths[position], position, lowerParent);
  }

  entryAt(position: number): WorkspacePathEntry {
    const relativePath = this.paths[position];
    const lowerPath = this.lowerPaths[position];
    const start = this.nameStarts[position];
    return {
      kind: this.kindAt(position),
      relativePath,
      lowerPath,
      name: relativePath.slice(start),
      lowerName: lowerPath.slice(start),
      parent: start === 0 ? "." : relativePath.slice(0, start - 1),
      lowerParent: start === 0 ? "." : lowerPath.slice(0, start - 1),
      position,
    };
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
    const files = this.files;
    const remaining = files.filter((item) => !removed(item));
    if (remaining.length === files.length) return;
    this.reset();
    this.appendNew(remaining);
    this.currentVersion++;
  }

  /** Compares without allocating the parent string. */
  private parentIs(
    relativePath: string,
    position: number,
    parent: string
  ): boolean {
    const start = this.nameStarts[position];
    if (parent === ".") return start === 0;
    return start === parent.length + 1 && relativePath.startsWith(parent);
  }

  private reset(): void {
    this.paths = [];
    this.lowerPaths = [];
    this.kinds = new Uint8Array(INITIAL_CAPACITY);
    this.nameStarts = new Uint32Array(INITIAL_CAPACITY);
    this.fileSet = new Set();
    this.directorySet = new Set();
    this.bytes = 0;
  }

  /** Appends unseen files (and their unseen parent directories) in order. */
  private appendNew(paths: readonly string[]): number {
    let added = 0;
    for (const raw of paths) {
      const file = normalizeReferencePath(raw);
      if (!file || file.startsWith("../") || this.fileSet.has(file)) continue;
      this.fileSet.add(file);
      // A directory is listed where its first file is rather than after them
      // all, because store order breaks ranking ties.
      let slash = file.lastIndexOf("/");
      while (slash > 0) {
        const parent = file.slice(0, slash);
        if (this.directorySet.has(parent)) break;
        this.directorySet.add(parent);
        this.append(KIND_DIRECTORY, parent);
        slash = parent.lastIndexOf("/");
      }
      this.append(KIND_FILE, file);
      added++;
    }
    return added;
  }

  private append(kind: number, relativePath: string): void {
    const position = this.paths.length;
    if (position === this.kinds.length) this.grow();
    const lower = relativePath.toLowerCase();
    this.paths.push(relativePath);
    // V8 copies even an unchanged string, so share the original instead.
    this.lowerPaths.push(lower === relativePath ? relativePath : lower);
    this.kinds[position] = kind;
    this.nameStarts[position] = relativePath.lastIndexOf("/") + 1;
    this.bytes += entryBytes(relativePath);
  }

  private grow(): void {
    const kinds = new Uint8Array(this.kinds.length * 2);
    kinds.set(this.kinds);
    this.kinds = kinds;
    const nameStarts = new Uint32Array(this.nameStarts.length * 2);
    nameStarts.set(this.nameStarts);
    this.nameStarts = nameStarts;
  }
}
