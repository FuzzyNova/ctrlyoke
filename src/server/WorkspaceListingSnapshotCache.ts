import { randomUUID } from "crypto";
import type {
  WorkspaceEntrySort,
  WorkspaceTreeEntry,
} from "../types/HostedWorkspaceViewerTypes";

/** Default idle lifetime for an immutable workspace directory listing. */
export const WORKSPACE_LISTING_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/** Maximum number of listing snapshots retained by one hosted server. */
export const WORKSPACE_LISTING_SNAPSHOT_MAX_COUNT = 32;

/** Soft aggregate target for retained listing metadata. */
export const WORKSPACE_LISTING_SNAPSHOT_MAX_ESTIMATED_METADATA_BYTES =
  8 * 1024 * 1024;

export interface WorkspaceEntryMetadata {
  size?: number;
  modifiedAt?: number;
}

export interface WorkspaceListingSnapshotInput {
  /** Canonical path obtained after the server's workspace safety checks. */
  resolvedDirectory: string;
  rootLabel: string;
  path: string;
  parentPath: string | null;
  isGitRepo: boolean;
  isRootsList: boolean;
  includeGitIgnored: boolean;
  /** Normalized sort selection captured by this immutable listing. */
  order: WorkspaceEntrySort;
  pageSize: number;
  entries: readonly WorkspaceTreeEntry[];
  /** Optional estimate supplied by the server; otherwise JSON metadata is estimated. */
  estimatedMetadataBytes?: number;
}

export interface WorkspaceListingSnapshot extends WorkspaceListingSnapshotInput {
  listingId: string;
  createdAt: number;
  lastAccessedAt: number;
  estimatedMetadataBytes: number;
}

export interface WorkspaceListingSnapshotCacheOptions {
  ttlMs?: number;
  maxCount?: number;
  maxEstimatedMetadataBytes?: number;
  now?: () => number;
  idFactory?: () => string;
}

interface CachedSnapshot {
  snapshot: WorkspaceListingSnapshot;
  metadata: Map<string, WorkspaceEntryMetadata>;
  inFlightMetadata: Map<string, Promise<WorkspaceEntryMetadata>>;
}

/**
 * Server-owned immutable listing snapshots with idle expiration and LRU bounds.
 *
 * The cache deliberately stores only navigation/filter/order metadata and
 * lightweight entry descriptors. Callers must pass a canonical directory that
 * was resolved and admitted by the server; this class does not accept or
 * resolve client paths itself.
 */
export class WorkspaceListingSnapshotCache {
  private readonly ttlMs: number;
  private readonly maxCount: number;
  private readonly maxEstimatedMetadataBytes: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly snapshots = new Map<string, CachedSnapshot>();
  private estimatedMetadataBytes = 0;
  private disposed = false;

  constructor(options: WorkspaceListingSnapshotCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? WORKSPACE_LISTING_SNAPSHOT_TTL_MS;
    this.maxCount = options.maxCount ?? WORKSPACE_LISTING_SNAPSHOT_MAX_COUNT;
    this.maxEstimatedMetadataBytes =
      options.maxEstimatedMetadataBytes ??
      WORKSPACE_LISTING_SNAPSHOT_MAX_ESTIMATED_METADATA_BYTES;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;

    if (this.ttlMs < 0) {
      throw new Error("Listing snapshot TTL must be non-negative");
    }
    if (!Number.isInteger(this.maxCount) || this.maxCount < 1) {
      throw new Error("Listing snapshot max count must be a positive integer");
    }
    if (
      !Number.isFinite(this.maxEstimatedMetadataBytes) ||
      this.maxEstimatedMetadataBytes < 0
    ) {
      throw new Error(
        "Listing snapshot metadata byte target must be non-negative"
      );
    }
  }

  get size(): number {
    return this.snapshots.size;
  }

  get totalEstimatedMetadataBytes(): number {
    return this.estimatedMetadataBytes;
  }

  /** Add a new immutable snapshot and return its opaque server-generated id. */
  create(
    input: WorkspaceListingSnapshotInput,
    initialMetadata: ReadonlyMap<string, WorkspaceEntryMetadata> = new Map()
  ): WorkspaceListingSnapshot {
    this.assertNotDisposed();
    const now = this.now();
    this.removeExpired(now);

    let listingId = this.idFactory();
    while (this.snapshots.has(listingId)) {
      listingId = this.idFactory();
    }

    const estimatedMetadataBytes =
      input.estimatedMetadataBytes ?? estimateMetadataBytes(input);
    if (
      !Number.isFinite(estimatedMetadataBytes) ||
      estimatedMetadataBytes < 0
    ) {
      throw new Error(
        "Listing snapshot metadata estimate must be non-negative"
      );
    }
    const snapshot = Object.freeze({
      ...input,
      entries: Object.freeze(
        input.entries.map((entry) => Object.freeze({ ...entry }))
      ),
      listingId,
      createdAt: now,
      lastAccessedAt: now,
      estimatedMetadataBytes,
    });
    const metadata = new Map<string, WorkspaceEntryMetadata>();
    for (const [entryPath, entryMetadata] of initialMetadata) {
      metadata.set(entryPath, freezeMetadata(entryMetadata));
    }
    this.snapshots.set(listingId, {
      snapshot,
      metadata,
      inFlightMetadata: new Map(),
    });
    this.estimatedMetadataBytes += estimatedMetadataBytes;

    this.enforceCountLimit();
    this.enforceByteTarget(listingId);
    return snapshot;
  }

  /**
   * Reuse a completed or in-flight metadata lookup for one snapshot entry.
   * The loader is expected to return an empty object for a failed stat; this
   * method also converts an unexpected rejection into cached missing metadata.
   */
  getOrCreateEntryMetadata(
    listingId: string,
    entryPath: string,
    loader: () => Promise<WorkspaceEntryMetadata>
  ): Promise<WorkspaceEntryMetadata> {
    const cached = this.snapshots.get(listingId);
    if (!cached) {
      return Promise.reject(new Error("Listing snapshot has expired"));
    }
    const existing = cached.metadata.get(entryPath);
    if (existing !== undefined) return Promise.resolve(existing);
    const inFlight = cached.inFlightMetadata.get(entryPath);
    if (inFlight) return inFlight;

    const pending = Promise.resolve()
      .then(loader)
      .catch(() => ({}))
      .then((metadata) => {
        const frozen = freezeMetadata(metadata);
        cached.metadata.set(entryPath, frozen);
        cached.inFlightMetadata.delete(entryPath);
        return frozen;
      });
    cached.inFlightMetadata.set(entryPath, pending);
    return pending;
  }

  /**
   * Return a snapshot and refresh its idle lifetime/LRU position. A missing or
   * expired id is intentionally indistinguishable from any other cache miss.
   */
  get(listingId: string): WorkspaceListingSnapshot | undefined {
    if (this.disposed) return undefined;
    const now = this.now();
    this.removeExpired(now);
    const cached = this.snapshots.get(listingId);
    if (!cached) return undefined;

    cached.snapshot = Object.freeze({
      ...cached.snapshot,
      lastAccessedAt: now,
    });
    this.snapshots.delete(listingId);
    this.snapshots.set(listingId, cached);
    return cached.snapshot;
  }

  /** Remove all snapshots while keeping this cache reusable. */
  clear(): void {
    this.snapshots.clear();
    this.estimatedMetadataBytes = 0;
  }

  /** Clear retained metadata and make this cache permanently inactive. */
  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Listing snapshot cache has been disposed");
    }
  }

  private removeExpired(now: number): void {
    for (const [listingId, cached] of this.snapshots) {
      if (now - cached.snapshot.lastAccessedAt >= this.ttlMs) {
        this.remove(listingId);
      }
    }
  }

  private enforceCountLimit(): void {
    while (this.snapshots.size > this.maxCount) {
      const oldestListingId = this.snapshots.keys().next().value;
      if (oldestListingId === undefined) return;
      this.remove(oldestListingId);
    }
  }

  private enforceByteTarget(newestListingId: string): void {
    while (
      this.estimatedMetadataBytes > this.maxEstimatedMetadataBytes &&
      this.snapshots.size > 1
    ) {
      const oldestListingId = this.snapshots.keys().next().value;
      if (oldestListingId === undefined) return;
      // The newest snapshot is always at the end after create(). Do not evict
      // it, even when it alone exceeds the soft aggregate target.
      if (oldestListingId === newestListingId) return;
      this.remove(oldestListingId);
    }
  }

  private remove(listingId: string): void {
    const cached = this.snapshots.get(listingId);
    if (!cached) return;
    this.snapshots.delete(listingId);
    this.estimatedMetadataBytes -= cached.snapshot.estimatedMetadataBytes;
  }
}

function estimateMetadataBytes(input: WorkspaceListingSnapshotInput): number {
  // The resolved directory is server-owned metadata. File bodies are not part
  // of the input and therefore cannot enter the estimate or the snapshot.
  return Buffer.byteLength(
    JSON.stringify({
      resolvedDirectory: input.resolvedDirectory,
      rootLabel: input.rootLabel,
      path: input.path,
      parentPath: input.parentPath,
      isGitRepo: input.isGitRepo,
      isRootsList: input.isRootsList,
      includeGitIgnored: input.includeGitIgnored,
      order: input.order,
      pageSize: input.pageSize,
      entries: input.entries,
    }),
    "utf8"
  );
}

function freezeMetadata(
  metadata: WorkspaceEntryMetadata
): WorkspaceEntryMetadata {
  return Object.freeze({ ...metadata });
}
