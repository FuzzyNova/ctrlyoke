import * as fs from "fs";
import * as path from "path";
import { GitLocationMemo, type GitLocationLookup } from "./GitUtils";
import { foldPathForCompare } from "./PathCasing";

export interface RuntimeTrustedRootHandle {
  readonly ownerToken: string;
  readonly rootPath: string;
  release(): void;
}

interface RuntimeTrustedRootGrant {
  rootPath: string;
  repositoryIdentity: string;
  repositoryMarker: string;
  owners: Map<string, number>;
}

/**
 * Process-session trust for worktree roots.
 *
 * This deliberately has no persistence or relationship with
 * ExternalRootsTrustStore. A grant is valid only while its owner retains a
 * reference and the path still points at the same Git repository.
 */
export class RuntimeTrustedRootRegistry {
  private readonly grants = new Map<string, RuntimeTrustedRootGrant>();

  async register(options: {
    rootPath: string;
    repositoryRoot?: string;
    ownerToken?: string;
    /** The caller's per-operation lookup, when it has already asked Git about these paths. */
    git?: GitLocationLookup;
  }): Promise<RuntimeTrustedRootHandle> {
    // Registration asks about the same repository several times; answer each once.
    const git = new GitLocationMemo(options.git);
    const rootPath = await this.requireDirectory(options.rootPath);
    const rootRepository = await git.repoToplevel(rootPath);
    if (!rootRepository) {
      throw new Error(
        `Runtime trusted root is not a Git worktree: ${rootPath}`
      );
    }

    const expectedRepository = options.repositoryRoot
      ? await git.repoToplevel(options.repositoryRoot)
      : rootRepository;
    if (
      !expectedRepository ||
      !(await this.sameRepository(git, rootRepository, expectedRepository))
    ) {
      throw new Error(
        `Runtime trusted root does not resolve to the expected repository: ${rootPath}`
      );
    }

    const repositoryIdentity = await this.repositoryIdentity(
      git,
      rootRepository
    );
    const repositoryMarker = this.readRepositoryMarker(rootPath);
    if (!repositoryMarker) {
      throw new Error(
        `Runtime trusted root has no stable Git identity: ${rootPath}`
      );
    }
    const ownerToken = options.ownerToken ?? cryptoRandomToken();
    const key = foldPathForCompare(rootPath);
    const existing = this.grants.get(key);
    if (
      existing &&
      (existing.repositoryIdentity !== repositoryIdentity ||
        existing.repositoryMarker !== repositoryMarker)
    ) {
      throw new Error(`Runtime trusted root changed repository: ${rootPath}`);
    }
    const grant = existing ?? {
      rootPath,
      repositoryIdentity,
      repositoryMarker,
      owners: new Map<string, number>(),
    };
    grant.owners.set(ownerToken, (grant.owners.get(ownerToken) ?? 0) + 1);
    this.grants.set(key, grant);

    let released = false;
    return {
      ownerToken,
      rootPath,
      release: () => {
        if (released) return;
        released = true;
        this.release(rootPath, ownerToken);
      },
    };
  }

  /** Return currently usable roots, pruning missing or replaced worktrees. */
  getRoots(): string[] {
    for (const [key, grant] of this.grants) {
      if (
        !fs.existsSync(grant.rootPath) ||
        this.readRepositoryMarker(grant.rootPath) !== grant.repositoryMarker
      ) {
        this.grants.delete(key);
      }
    }
    return [...this.grants.values()].map((grant) => grant.rootPath);
  }

  /** Remove one reference held by an owner. */
  release(rootPath: string, ownerToken: string): void {
    const key = foldPathForCompare(path.resolve(rootPath));
    const grant = this.grants.get(key);
    if (!grant) return;
    const count = grant.owners.get(ownerToken) ?? 0;
    if (count <= 1) grant.owners.delete(ownerToken);
    else grant.owners.set(ownerToken, count - 1);
    if (grant.owners.size === 0) this.grants.delete(key);
  }

  /** Test/host-lifecycle escape hatch; no filesystem state is touched. */
  clear(): void {
    this.grants.clear();
  }

  private async requireDirectory(value: string): Promise<string> {
    const resolved = path.resolve(value);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Runtime trusted root is not a directory: ${resolved}`);
    }
    return path.normalize(await fs.promises.realpath(resolved));
  }

  private async sameRepository(
    git: GitLocationLookup,
    left: string,
    right: string
  ): Promise<boolean> {
    const [leftCommon, rightCommon] = await Promise.all([
      git.gitCommonDir(left),
      git.gitCommonDir(right),
    ]);
    return Boolean(
      leftCommon &&
      rightCommon &&
      foldPathForCompare(path.resolve(leftCommon)) ===
        foldPathForCompare(path.resolve(rightCommon))
    );
  }

  private async repositoryIdentity(
    git: GitLocationLookup,
    repositoryRoot: string
  ): Promise<string> {
    const common = await git.gitCommonDir(repositoryRoot);
    return foldPathForCompare(path.resolve(common ?? repositoryRoot));
  }

  private readRepositoryMarker(rootPath: string): string | undefined {
    const gitPath = path.join(rootPath, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) return path.normalize(fs.realpathSync(gitPath));
      const contents = fs.readFileSync(gitPath, "utf8").trim();
      const gitDir = contents.match(/^gitdir:\s*(.+)$/i)?.[1];
      return gitDir
        ? path.normalize(fs.realpathSync(path.resolve(rootPath, gitDir.trim())))
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function cryptoRandomToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const runtimeTrustedRootRegistry = new RuntimeTrustedRootRegistry();
