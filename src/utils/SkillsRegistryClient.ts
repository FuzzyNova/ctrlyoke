/**
 * skills.sh registry client for the Agent & Skills Manager.
 *
 * skills.sh (run by Vercel) documents only its audit route for keyless use.
 * Search uses the same undocumented route as the `skills find` CLI, so this
 * client is a replaceable adapter: every response is validated at runtime and
 * an unexpected shape reads as "skills.sh is unavailable", never as a crash.
 *
 * Skill files come from the publishing GitHub repository, not from skills.sh:
 * the GitHub trees API locates the skill folder at one pinned commit and
 * raw.githubusercontent.com serves its files. That is the CLI's own fallback
 * path, and it installs exactly the files the user can review on GitHub.
 *
 * All I/O runs in the extension host — never in the webview. Every request is
 * user-initiated and sends only the search text or a public `owner/repo`.
 */

import type {
  RegistrySkillAudit,
  RegistrySkillAuditResult,
  RegistrySkillEntry,
  RegistrySkillLocation,
} from "../types/WebviewMessageTypes";
import {
  DATA_SOURCES,
  SKILL_AUDIT_STATUSES,
  SKILL_UPDATE_STATUSES,
  type SkillAuditStatus,
  type SkillUpdateStatus,
} from "../types/DashboardConstants";
import { parseAgentFrontmatter } from "./AgentDiscovery";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import { getErrorMessage } from "./ErrorUtils";
import { isSafePathSegment } from "./PathSecurity";
import topSkillsSnapshotData from "./generated/skillsShTopSkills.json";

type FetchFn = typeof fetch;
type JsonRecord = Record<string, unknown>;

/** Dev override for the skills.sh base URL, like the CLI's `SKILLS_API_URL`. */
export const SKILLS_API_URL_ENV = "CTRLYOKE_SKILLS_API_URL";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_RAW_URL = "https://raw.githubusercontent.com";
const GITHUB_HOST = "github.com";

const USER_AGENT = "ctrlyoke-skills-registry";
const REQUEST_TIMEOUT_MS = 10_000;

/** The most results one search asks skills.sh for. */
export const SKILLS_SEARCH_LIMIT = 50;
/** skills.sh rejects shorter queries with HTTP 400. */
export const SKILLS_SEARCH_MIN_QUERY_LENGTH = 2;

/** SKILL.md files whose frontmatter may be read to match a slug. */
/** Safety bound for unusually large repositories; the UI reports when reached. */
const MAX_FRONTMATTER_PROBES = 200;
/** Non-recursive GitHub tree requests used after a recursive tree is truncated. */
const MAX_TRUNCATED_TREE_REQUESTS = 20;
/** Bounds on what one install may download. */
export const SKILL_INSTALL_LIMITS = {
  MAX_FILES: 200,
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  MAX_TOTAL_BYTES: 10 * 1024 * 1024,
} as const;
const DOWNLOAD_CONCURRENCY = 4;
const AUDIT_CONCURRENCY = 4;
const UPDATE_CHECK_CONCURRENCY = 4;
/**
 * How long an update check reuses a repository's HEAD commit, so checking
 * several skills from one repository asks GitHub once.
 */
const HEAD_COMMIT_CACHE_MS = 60_000;

const SKILL_FILE_NAME = "skill.md";
const GIT_TREE_ENTRY_TYPES = { BLOB: "blob", TREE: "tree" } as const;
const GIT_SYMLINK_MODE = "120000";
/** Folders and files the CLI's installer skips as well. */
const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  "__pycache__",
  "__pypackages__",
  "node_modules",
]);
const EXCLUDED_FILE_NAMES = new Set(["metadata.json"]);

const SOURCE_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ANSI_ESCAPE_PATTERN =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P^_][^\x1b]*\x1b\\|[ -~])/g;
/** Control characters except tab and newline, which become spaces first. */
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

const MAX_NAME_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;

/** Which service a {@link SkillsRegistryError} came from, for its message. */
const REGISTRY_SERVICES = {
  SKILLS_SH: DATA_SOURCES.SKILLS_SH.label,
  GITHUB: "GitHub",
} as const;

/**
 * A failure talking to skills.sh or GitHub. Its message always names the
 * service, so the UI never presents it as a ctrlyoke error.
 */
export class SkillsRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsRegistryError";
  }
}

/** A downloaded skill file, `path` relative to the skill folder. */
export interface DownloadedSkillFile {
  path: string;
  content: Uint8Array;
}

/** What the update check needs to know about an installed copy. */
export interface InstalledRegistrySkill {
  source: string;
  slug: string;
  commitSha: string;
  skillMdPath: string;
  /** Git blob SHA of each installed file, keyed by folder-relative path. */
  files: Readonly<Record<string, string>>;
}

/** An installed skill compared with its repository's current commit. */
export interface SkillUpdateCheck {
  status: Exclude<SkillUpdateStatus, typeof SKILL_UPDATE_STATUSES.FAILED>;
  latestCommitSha: string;
}

/** The skills.sh leaderboard bundled with ctrlyoke (`npm run sync-skills-snapshot`). */
export interface TopSkillsSnapshot {
  /** Sorted by installs, most first. Empty when no snapshot was taken. */
  skills: RegistrySkillEntry[];
  /** ISO date the snapshot was taken. */
  generatedAt?: string;
}

/** The registry operations the Agent & Skills Manager uses. */
export interface SkillsRegistry {
  searchSkills(query: string): Promise<RegistrySkillEntry[]>;
  /** The bundled top skills; reads no network. */
  getTopSkills(): TopSkillsSnapshot;
  /** `null` when skills.sh has not audited the skill yet. */
  getSkillAudits(
    source: string,
    slug: string
  ): Promise<RegistrySkillAudit[] | null>;
  resolveSkill(source: string, slug: string): Promise<RegistrySkillLocation>;
  downloadSkill(
    location: RegistrySkillLocation
  ): Promise<DownloadedSkillFile[]>;
  checkForUpdate(installed: InstalledRegistrySkill): Promise<SkillUpdateCheck>;
}

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * skills.sh's slug for a skill name. Must match the server-side `toSkillSlug`
 * (vercel-labs/skills `src/blob.ts`), because the folder a slug names is found
 * by slugging each candidate SKILL.md's frontmatter `name`.
 */
export function toSkillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Third-party text made safe to display: escape sequences and control
 * characters removed, whitespace collapsed to one line, length bounded.
 */
export function sanitizeRegistryText(
  value: string,
  maxLength = MAX_TEXT_LENGTH
): string {
  const clean = value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL_CHAR_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

export function isValidSkillSource(source: string): boolean {
  return (
    SOURCE_PATTERN.test(source) &&
    source.split("/").every((part) => part !== "." && part !== "..")
  );
}

/** A slug safe to use as a folder name: no separators, not `.`/`..`. */
export function isValidSkillSlug(slug: string): boolean {
  return (
    SLUG_PATTERN.test(slug) &&
    slug.length <= MAX_NAME_LENGTH &&
    isSafePathSegment(slug)
  );
}

/**
 * A repository-relative file path made relative to the skill folder, or
 * `null` when it is outside the folder or any segment is unsafe.
 */
export function toSkillRelativePath(
  repoPath: string,
  folderPath: string
): string | null {
  const prefix = folderPath ? `${folderPath}/` : "";
  if (prefix && !repoPath.startsWith(prefix)) return null;
  const relative = repoPath.slice(prefix.length);
  if (!relative || relative.startsWith("/")) return null;
  const segments = relative.split("/");
  return segments.every(isSafePathSegment) ? relative : null;
}

function isPlainObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = sanitizeRegistryText(value);
  return text || undefined;
}

function toAuditStatus(value: unknown): SkillAuditStatus {
  // An unknown verdict is treated as a warning so it still needs the
  // explicit second confirmation before install.
  return value === SKILL_AUDIT_STATUSES.PASS ||
    value === SKILL_AUDIT_STATUSES.FAIL
    ? value
    : SKILL_AUDIT_STATUSES.WARN;
}

/** Parse a `/api/search` body. Throws on an unexpected top-level shape. */
export function parseSkillsSearchResponse(data: unknown): RegistrySkillEntry[] {
  if (!isPlainObject(data) || !Array.isArray(data.skills)) {
    throw new SkillsRegistryError(
      `${REGISTRY_SERVICES.SKILLS_SH} search returned an unexpected response`
    );
  }
  const seen = new Set<string>();
  return data.skills.flatMap((item): RegistrySkillEntry[] => {
    if (!isPlainObject(item)) return [];
    const { source, name, installs } = item;
    if (typeof source !== "string" || !isValidSkillSource(source)) return [];
    const rawSlug =
      typeof item.skillId === "string"
        ? item.skillId
        : typeof item.id === "string"
          ? item.id.split("/").pop()
          : undefined;
    if (!rawSlug || !isValidSkillSlug(rawSlug)) return [];
    const id = `${source}/${rawSlug}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const displayName =
      typeof name === "string"
        ? sanitizeRegistryText(name, MAX_NAME_LENGTH)
        : "";
    return [
      {
        id,
        source,
        slug: rawSlug,
        name: displayName || rawSlug,
        installs:
          typeof installs === "number" &&
          Number.isFinite(installs) &&
          installs > 0
            ? Math.floor(installs)
            : 0,
      },
    ];
  });
}

/**
 * Parse the bundled top skills snapshot, which keeps the `/api/search` shape
 * plus `generatedAt`. An unexpected shape reads as no snapshot.
 */
export function parseTopSkillsSnapshot(data: unknown): TopSkillsSnapshot {
  if (!isPlainObject(data) || !Array.isArray(data.skills)) {
    return { skills: [] };
  }
  const skills = parseSkillsSearchResponse(data).sort(
    (a, b) => b.installs - a.installs
  );
  const generatedAt =
    typeof data.generatedAt === "string" &&
    !Number.isNaN(Date.parse(data.generatedAt))
      ? data.generatedAt
      : undefined;
  return skills.length > 0 && generatedAt
    ? { skills, generatedAt }
    : { skills: [] };
}

/** Parse a `/api/v1/skills/audit` body. Throws on an unexpected shape. */
export function parseSkillAuditResponse(data: unknown): RegistrySkillAudit[] {
  if (!isPlainObject(data) || !Array.isArray(data.audits)) {
    throw new SkillsRegistryError(
      `${REGISTRY_SERVICES.SKILLS_SH} returned an unexpected audit response`
    );
  }
  return data.audits.flatMap((item): RegistrySkillAudit[] => {
    if (!isPlainObject(item) || typeof item.provider !== "string") return [];
    const provider = sanitizeRegistryText(item.provider, MAX_NAME_LENGTH);
    const providerSlug =
      typeof item.slug === "string" && isValidSkillSlug(item.slug)
        ? item.slug
        : toSkillSlug(provider);
    if (!provider || !providerSlug) return [];
    const riskLevel = optionalText(item.riskLevel);
    const summary = optionalText(item.summary);
    const auditedAt = optionalText(item.auditedAt);
    return [
      {
        provider,
        providerSlug,
        status: toAuditStatus(item.status),
        ...(riskLevel ? { riskLevel } : {}),
        ...(summary ? { summary } : {}),
        ...(auditedAt ? { auditedAt } : {}),
      },
    ];
  });
}

interface GitTreeEntry {
  path: string;
  type: string;
  mode?: string;
  size?: number;
  /** Git object SHA; for a blob, what `gitBlobSha` computes from its content. */
  sha?: string;
}

/** Parse a GitHub `git/trees?recursive=1` body. */
export function parseGitTreeResponse(data: unknown): GitTreeEntry[] {
  if (!isPlainObject(data) || !Array.isArray(data.tree)) {
    throw new SkillsRegistryError(
      `${REGISTRY_SERVICES.GITHUB} returned an unexpected repository tree`
    );
  }
  if (data.truncated === true) {
    throw new SkillsRegistryError(
      `${REGISTRY_SERVICES.GITHUB} truncated the repository tree because the repository is too large to search for the skill`
    );
  }
  return data.tree.flatMap((entry): GitTreeEntry[] =>
    isPlainObject(entry) &&
    typeof entry.path === "string" &&
    typeof entry.type === "string"
      ? [
          {
            path: entry.path,
            type: entry.type,
            ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
            ...(typeof entry.size === "number" ? { size: entry.size } : {}),
            ...(typeof entry.sha === "string" ? { sha: entry.sha } : {}),
          },
        ]
      : []
  );
}

function getFolderPath(skillMdPath: string): string {
  const index = skillMdPath.lastIndexOf("/");
  return index < 0 ? "" : skillMdPath.slice(0, index);
}

function getFolderName(folderPath: string, source: string): string {
  return folderPath
    ? (folderPath.split("/").pop() ?? folderPath)
    : (source.split("/").pop() ?? source);
}

/**
 * SKILL.md paths in a tree, most likely matches for `slug` first: those whose
 * folder path contains a segment that slugs to it, then shallower paths.
 */
export function rankSkillMdCandidates(
  tree: readonly GitTreeEntry[],
  source: string,
  slug: string
): string[] {
  const candidates = tree
    .filter(
      (entry) =>
        entry.type === GIT_TREE_ENTRY_TYPES.BLOB &&
        entry.mode !== GIT_SYMLINK_MODE &&
        (entry.path.toLowerCase() === SKILL_FILE_NAME ||
          entry.path.toLowerCase().endsWith(`/${SKILL_FILE_NAME}`)) &&
        entry.path
          .split("/")
          .every((segment) => !EXCLUDED_DIR_NAMES.has(segment))
    )
    .map((entry) => entry.path);
  const score = (skillMdPath: string): number => {
    const folderPath = getFolderPath(skillMdPath);
    const folderSegments = folderPath
      ? folderPath.split("/")
      : [source.split("/").pop() ?? source];
    return folderSegments.some((segment) => toSkillSlug(segment) === slug)
      ? 0
      : 1;
  };
  return candidates.sort(
    (a, b) =>
      score(a) - score(b) ||
      a.split("/").length - b.split("/").length ||
      a.localeCompare(b)
  );
}

/**
 * The files to download for a skill folder. Throws when the folder holds an
 * unsafe path or exceeds {@link SKILL_INSTALL_LIMITS}.
 */
export function selectSkillFiles(
  tree: readonly GitTreeEntry[],
  folderPath: string
): Array<{ repoPath: string; path: string; sha?: string }> {
  const prefix = folderPath ? `${folderPath}/` : "";
  const selected: Array<{ repoPath: string; path: string; sha?: string }> = [];
  let totalBytes = 0;
  for (const entry of tree) {
    if (entry.type !== GIT_TREE_ENTRY_TYPES.BLOB) continue;
    if (prefix && !entry.path.startsWith(prefix)) continue;
    const segments = entry.path.slice(prefix.length).split("/");
    const fileName = segments[segments.length - 1] ?? "";
    if (
      segments
        .slice(0, -1)
        .some((segment) => EXCLUDED_DIR_NAMES.has(segment)) ||
      EXCLUDED_FILE_NAMES.has(fileName)
    ) {
      continue;
    }
    // Symlinks could point anywhere once written; skip them.
    if (entry.mode === GIT_SYMLINK_MODE) continue;
    const relative = toSkillRelativePath(entry.path, folderPath);
    if (!relative) {
      throw new SkillsRegistryError(
        `The skill contains a file path ctrlyoke will not write: ${sanitizeRegistryText(entry.path, MAX_NAME_LENGTH)}`
      );
    }
    const size = entry.size ?? 0;
    if (size > SKILL_INSTALL_LIMITS.MAX_FILE_BYTES) {
      throw new SkillsRegistryError(
        `The skill contains a file larger than ${SKILL_INSTALL_LIMITS.MAX_FILE_BYTES / (1024 * 1024)} MB: ${relative}`
      );
    }
    totalBytes += size;
    selected.push({
      repoPath: entry.path,
      path: relative,
      ...(entry.sha ? { sha: entry.sha } : {}),
    });
  }
  if (selected.length > SKILL_INSTALL_LIMITS.MAX_FILES) {
    throw new SkillsRegistryError(
      `The skill has ${selected.length} files, more than the ${SKILL_INSTALL_LIMITS.MAX_FILES} ctrlyoke installs`
    );
  }
  if (totalBytes > SKILL_INSTALL_LIMITS.MAX_TOTAL_BYTES) {
    throw new SkillsRegistryError(
      `The skill is larger than ${SKILL_INSTALL_LIMITS.MAX_TOTAL_BYTES / (1024 * 1024)} MB`
    );
  }
  return selected;
}

/** Run `task` over `items` with at most `limit` in flight, keeping order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.ceil(seconds))} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/** A rate-limit message from `Retry-After` or GitHub's `x-ratelimit-reset`. */
function describeRateLimit(service: string, response: Response): string {
  const retryAfter = Number(response.headers.get("retry-after"));
  const resetAt = Number(response.headers.get("x-ratelimit-reset"));
  const waitSeconds =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : Number.isFinite(resetAt) && resetAt > 0
        ? resetAt - Date.now() / 1000
        : undefined;
  return waitSeconds !== undefined && waitSeconds > 0
    ? `${service} is rate-limiting requests from this network; try again in ${formatWait(waitSeconds)}`
    : `${service} is rate-limiting requests from this network; try again later`;
}

function isRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0")
  );
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isPlainObject(body)) {
      const detail = body.error ?? body.message;
      if (typeof detail === "string" && detail.trim()) {
        return `: ${sanitizeRegistryText(detail, MAX_NAME_LENGTH)}`;
      }
    }
  } catch {
    // Not JSON; the status line is all there is.
  }
  return "";
}

// ============================================================================
// Client
// ============================================================================

export interface SkillsShRegistryClientOptions {
  fetch?: FetchFn;
  /** skills.sh base URL; defaults to {@link SKILLS_API_URL_ENV} or skills.sh. */
  baseUrl?: string;
  /** Raw top skills snapshot; defaults to the bundled one. */
  topSkillsSnapshot?: unknown;
}

/** {@link SkillsRegistry} backed by skills.sh search/audits and GitHub files. */
export class SkillsShRegistryClient implements SkillsRegistry {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly topSkillsSnapshot: unknown;
  private topSkills: TopSkillsSnapshot | undefined;
  /** Trees by `source@commit`; a commit's tree never changes. */
  private readonly treeCache = new Map<string, GitTreeEntry[]>();
  private readonly truncatedTreeKeys = new Set<string>();
  private readonly headCache = new Map<
    string,
    { sha: Promise<string>; fetchedAt: number }
  >();

  constructor(options: SkillsShRegistryClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.topSkillsSnapshot = options.topSkillsSnapshot ?? topSkillsSnapshotData;
    this.baseUrl = (
      options.baseUrl ??
      process.env[SKILLS_API_URL_ENV] ??
      DATA_SOURCES.SKILLS_SH.url
    ).replace(/\/+$/, "");
  }

  async searchSkills(query: string): Promise<RegistrySkillEntry[]> {
    const trimmed = query.trim();
    if (trimmed.length < SKILLS_SEARCH_MIN_QUERY_LENGTH) return [];
    const params = new URLSearchParams({
      q: trimmed,
      limit: String(SKILLS_SEARCH_LIMIT),
    });
    const response = await this.request(
      REGISTRY_SERVICES.SKILLS_SH,
      `${this.baseUrl}/api/search?${params}`,
      "search"
    );
    const results = parseSkillsSearchResponse(
      await this.readJson(response, REGISTRY_SERVICES.SKILLS_SH)
    );
    return results.sort((a, b) => b.installs - a.installs);
  }

  getTopSkills(): TopSkillsSnapshot {
    this.topSkills ??= parseTopSkillsSnapshot(this.topSkillsSnapshot);
    return this.topSkills;
  }

  async getSkillAudits(
    source: string,
    slug: string
  ): Promise<RegistrySkillAudit[] | null> {
    this.assertSkillId(source, slug);
    const response = await this.request(
      REGISTRY_SERVICES.SKILLS_SH,
      `${this.baseUrl}/api/v1/skills/audit/${source}/${encodeURIComponent(slug)}`,
      "security audits",
      { allowNotFound: true }
    );
    if (response.status === 404) return null;
    return parseSkillAuditResponse(
      await this.readJson(response, REGISTRY_SERVICES.SKILLS_SH)
    );
  }

  async resolveSkill(
    source: string,
    slug: string
  ): Promise<RegistrySkillLocation> {
    this.assertSkillId(source, slug);
    const commitSha = await this.fetchHeadCommit(source);
    const result = await this.findSkillAtCommit(source, slug, commitSha);
    if (!result.location) {
      const searchSummary =
        result.candidateCount > result.searchedCount
          ? ` (searched ${result.searchedCount} of ${result.candidateCount} SKILL.md files)`
          : "";
      throw new SkillsRegistryError(
        `Could not find the "${slug}" skill in ${GITHUB_HOST}/${source}${
          this.truncatedTreeKeys.has(`${source}@${commitSha}`)
            ? " after searching likely locations in the truncated repository tree"
            : searchSummary
        }`
      );
    }
    return result.location;
  }

  /**
   * Compare an installed copy with the repository's current commit. The
   * folder's file SHAs are compared, so commits that touch only other parts
   * of the repository are not an update. Costs at most two GitHub API calls
   * per repository (HEAD and its tree), and none beyond HEAD when nothing
   * was committed since the install.
   */
  async checkForUpdate(
    installed: InstalledRegistrySkill
  ): Promise<SkillUpdateCheck> {
    const { source, slug } = installed;
    this.assertSkillId(source, slug);
    const latestCommitSha = await this.headCommit(source);
    if (latestCommitSha === installed.commitSha) {
      return { status: SKILL_UPDATE_STATUSES.UP_TO_DATE, latestCommitSha };
    }
    const tree = await this.fetchTree(source, latestCommitSha, slug);
    const existingPath = tree.some(
      (entry) =>
        entry.type === GIT_TREE_ENTRY_TYPES.BLOB &&
        entry.path === installed.skillMdPath
    )
      ? installed.skillMdPath
      : undefined;
    let skillMdPath = existingPath;
    if (skillMdPath === undefined) {
      const result = await this.findSkillAtCommit(
        source,
        slug,
        latestCommitSha
      );
      skillMdPath = result.location?.skillMdPath;
      if (!skillMdPath && result.searchedCount < result.candidateCount) {
        throw new SkillsRegistryError(
          `Could not confirm the "${slug}" skill in ${GITHUB_HOST}/${source} ` +
            `(searched ${result.searchedCount} of ${result.candidateCount} SKILL.md files)`
        );
      }
    }
    if (skillMdPath === undefined) {
      return { status: SKILL_UPDATE_STATUSES.NOT_FOUND, latestCommitSha };
    }
    const latest = selectSkillFiles(tree, getFolderPath(skillMdPath));
    const unchanged =
      latest.length === Object.keys(installed.files).length &&
      latest.every(
        (file) =>
          file.sha !== undefined && installed.files[file.path] === file.sha
      );
    return {
      status: unchanged
        ? SKILL_UPDATE_STATUSES.UP_TO_DATE
        : SKILL_UPDATE_STATUSES.UPDATE_AVAILABLE,
      latestCommitSha,
    };
  }

  async downloadSkill(
    location: RegistrySkillLocation
  ): Promise<DownloadedSkillFile[]> {
    this.assertLocation(location);
    const tree = await this.fetchTree(
      location.source,
      location.commitSha,
      location.slug
    );
    const hasSkillMd = tree.some(
      (entry) =>
        entry.type === GIT_TREE_ENTRY_TYPES.BLOB &&
        entry.path === location.skillMdPath
    );
    if (!hasSkillMd) {
      throw new SkillsRegistryError(
        `${location.skillMdPath} is not in ${location.source} at commit ${location.commitSha.slice(0, 7)}`
      );
    }
    const files = selectSkillFiles(tree, location.folderPath);
    let totalBytes = 0;
    return mapWithConcurrency(files, DOWNLOAD_CONCURRENCY, async (file) => {
      const content = await this.fetchRawBytes(
        location.source,
        location.commitSha,
        file.repoPath
      );
      if (content.byteLength > SKILL_INSTALL_LIMITS.MAX_FILE_BYTES) {
        throw new SkillsRegistryError(
          `${file.path} is larger than ${SKILL_INSTALL_LIMITS.MAX_FILE_BYTES / (1024 * 1024)} MB`
        );
      }
      totalBytes += content.byteLength;
      if (totalBytes > SKILL_INSTALL_LIMITS.MAX_TOTAL_BYTES) {
        throw new SkillsRegistryError(
          `The skill is larger than ${SKILL_INSTALL_LIMITS.MAX_TOTAL_BYTES / (1024 * 1024)} MB`
        );
      }
      return { path: file.path, content };
    });
  }

  // --------------------------------------------------------------------------

  private assertSkillId(source: string, slug: string): void {
    if (!isValidSkillSource(source) || !isValidSkillSlug(slug)) {
      throw new SkillsRegistryError(
        `Not a valid skills.sh skill: ${source}/${slug}`
      );
    }
  }

  private assertLocation(location: RegistrySkillLocation): void {
    this.assertSkillId(location.source, location.slug);
    const folderOk =
      location.folderPath === "" ||
      location.folderPath.split("/").every(isSafePathSegment);
    const skillMdOk =
      getFolderPath(location.skillMdPath) === location.folderPath &&
      (location.skillMdPath.split("/").pop() ?? "").toLowerCase() ===
        SKILL_FILE_NAME;
    if (
      !COMMIT_SHA_PATTERN.test(location.commitSha) ||
      !folderOk ||
      !skillMdOk
    ) {
      throw new SkillsRegistryError("The skill location is not valid");
    }
  }

  private async request(
    service: string,
    url: string,
    what: string,
    options: { accept?: string; allowNotFound?: boolean } = {}
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: options.accept ?? "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SkillsRegistryError(
        `${service} ${what} is unavailable: ${getErrorMessage(error)}`
      );
    }
    if (response.ok || (options.allowNotFound && response.status === 404)) {
      return response;
    }
    if (isRateLimited(response)) {
      throw new SkillsRegistryError(describeRateLimit(service, response));
    }
    throw new SkillsRegistryError(
      `${service} ${what} is unavailable (HTTP ${response.status})${await readErrorDetail(response)}`
    );
  }

  private async readJson(
    response: Response,
    service: string
  ): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new SkillsRegistryError(
        `${service} returned a response that is not JSON`
      );
    }
  }

  /**
   * The skill folder whose SKILL.md frontmatter name slugs to `slug` at one
   * commit, or `undefined` when no candidate matches.
   */
  private async findSkillAtCommit(
    source: string,
    slug: string,
    commitSha: string
  ): Promise<{
    location?: RegistrySkillLocation;
    candidateCount: number;
    searchedCount: number;
  }> {
    const tree = await this.fetchTree(source, commitSha, slug);
    const ranked = rankSkillMdCandidates(tree, source, slug);
    const candidates = ranked.slice(0, MAX_FRONTMATTER_PROBES);
    for (
      let offset = 0;
      offset < candidates.length;
      offset += DOWNLOAD_CONCURRENCY
    ) {
      const batch = candidates.slice(offset, offset + DOWNLOAD_CONCURRENCY);
      const contents = await Promise.all(
        batch.map((skillMdPath) =>
          this.fetchRawText(source, commitSha, skillMdPath)
        )
      );
      // Probe concurrently, but inspect each batch in rank order so the
      // selected match is deterministic and no lower-ranked batch is needed.
      for (let index = 0; index < batch.length; index++) {
        const skillMdPath = batch[index]!;
        const content = contents[index];
        if (content === null || content === undefined) continue;
        const frontmatter = parseAgentFrontmatter(content);
        const folderPath = getFolderPath(skillMdPath);
        const name = frontmatter.name ?? getFolderName(folderPath, source);
        if (toSkillSlug(name) !== slug) continue;
        const description = frontmatter.description
          ? sanitizeRegistryText(frontmatter.description)
          : undefined;
        return {
          location: {
            source,
            slug,
            commitSha,
            folderPath,
            skillMdPath,
            name: sanitizeRegistryText(name, MAX_NAME_LENGTH) || slug,
            ...(description ? { description } : {}),
          },
          candidateCount: ranked.length,
          searchedCount: offset + index + 1,
        };
      }
    }
    return {
      candidateCount: ranked.length,
      searchedCount: candidates.length,
    };
  }

  /** {@link fetchHeadCommit}, shared for {@link HEAD_COMMIT_CACHE_MS}. */
  private headCommit(source: string): Promise<string> {
    const cached = this.headCache.get(source);
    if (cached && Date.now() - cached.fetchedAt < HEAD_COMMIT_CACHE_MS) {
      return cached.sha;
    }
    const sha = this.fetchHeadCommit(source);
    this.headCache.set(source, { sha, fetchedAt: Date.now() });
    // A failure is not remembered; the next check asks again.
    sha.catch(() => this.headCache.delete(source));
    return sha;
  }

  private async fetchHeadCommit(source: string): Promise<string> {
    const response = await this.request(
      REGISTRY_SERVICES.GITHUB,
      `${GITHUB_API_URL}/repos/${source}/commits/HEAD`,
      `lookup of ${source}`,
      { accept: "application/vnd.github.sha" }
    );
    const sha = (await response.text()).trim();
    if (!COMMIT_SHA_PATTERN.test(sha)) {
      throw new SkillsRegistryError(
        `${REGISTRY_SERVICES.GITHUB} returned an unexpected commit for ${source}`
      );
    }
    return sha;
  }

  private async fetchTree(
    source: string,
    commitSha: string,
    preferredSlug?: string
  ): Promise<GitTreeEntry[]> {
    const key = `${source}@${commitSha}`;
    const cached = this.treeCache.get(key);
    if (cached) return cached;
    const response = await this.request(
      REGISTRY_SERVICES.GITHUB,
      `${GITHUB_API_URL}/repos/${source}/git/trees/${commitSha}?recursive=1`,
      `tree of ${source}`,
      { accept: "application/vnd.github+json" }
    );
    const data = await this.readJson(response, REGISTRY_SERVICES.GITHUB);
    const tree = isPlainObject(data) && data.truncated === true
      ? await this.walkTruncatedTree(source, commitSha, data, preferredSlug)
      : parseGitTreeResponse(data);
    this.treeCache.set(key, tree);
    return tree;
  }

  /**
   * GitHub caps recursive trees. Walk a small number of likely directory
   * trees, keeping paths rooted at the repository so existing ranking,
   * probing, download, and update code can consume the result unchanged.
   */
  private async walkTruncatedTree(
    source: string,
    commitSha: string,
    truncatedData: JsonRecord,
    preferredSlug?: string
  ): Promise<GitTreeEntry[]> {
    const key = `${source}@${commitSha}`;
    this.truncatedTreeKeys.add(key);
    const collected = parseGitTreeResponse({
      ...truncatedData,
      truncated: false,
    });
    const collectedPaths = new Set(collected.map((entry) => entry.path));
    const queue: Array<{ path: string; sha: string }> = [];
    const visited = new Set<string>();
    let requests = 0;

    const priority = (path: string): number => {
      if (path === PATH_CONSTANTS.SKILLS_DIR) return 0;
      if (path === ".claude/skills") return 0;
      if (
        preferredSlug &&
        path
          .split("/")
          .some((segment) => toSkillSlug(segment) === preferredSlug)
      ) {
        return 1;
      }
      if (path === ".claude") return 1;
      return 3;
    };
    const enqueue = (path: string, sha: string): void => {
      if (EXCLUDED_DIR_NAMES.has(path.split("/").pop() ?? "")) return;
      if (visited.has(sha) || queue.some((entry) => entry.sha === sha)) return;
      queue.push({ path, sha });
      queue.sort(
        (a, b) =>
          priority(a.path) - priority(b.path) ||
          a.path.split("/").length - b.path.split("/").length ||
          a.path.localeCompare(b.path)
      );
    };
    const appendEntries = (
      entries: GitTreeEntry[],
      parentPath: string
    ): void => {
      for (const entry of entries) {
        const path = parentPath ? `${parentPath}/${entry.path}` : entry.path;
        const rooted = { ...entry, path };
        if (!collectedPaths.has(path)) {
          collected.push(rooted);
          collectedPaths.add(path);
        }
        if (entry.type === GIT_TREE_ENTRY_TYPES.TREE && entry.sha) {
          enqueue(path, entry.sha);
        }
      }
    };

    const root = await this.fetchNonRecursiveTree(source, commitSha);
    requests++;
    appendEntries(root, "");
    while (queue.length > 0 && requests < MAX_TRUNCATED_TREE_REQUESTS) {
      const next = queue.shift()!;
      if (visited.has(next.sha)) continue;
      visited.add(next.sha);
      const entries = await this.fetchNonRecursiveTree(source, next.sha);
      requests++;
      appendEntries(entries, next.path);
    }
    return collected;
  }

  private async fetchNonRecursiveTree(
    source: string,
    treeSha: string
  ): Promise<GitTreeEntry[]> {
    const response = await this.request(
      REGISTRY_SERVICES.GITHUB,
      `${GITHUB_API_URL}/repos/${source}/git/trees/${treeSha}`,
      `tree of ${source}`,
      { accept: "application/vnd.github+json" }
    );
    const data = await this.readJson(response, REGISTRY_SERVICES.GITHUB);
    return parseGitTreeResponse(
      isPlainObject(data) ? { ...data, truncated: false } : data
    );
  }

  private rawUrl(source: string, commitSha: string, repoPath: string): string {
    const encodedPath = repoPath.split("/").map(encodeURIComponent).join("/");
    return `${GITHUB_RAW_URL}/${source}/${commitSha}/${encodedPath}`;
  }

  private async fetchRawText(
    source: string,
    commitSha: string,
    repoPath: string
  ): Promise<string | null> {
    try {
      const response = await this.request(
        REGISTRY_SERVICES.GITHUB,
        this.rawUrl(source, commitSha, repoPath),
        `download of ${repoPath}`,
        { accept: "text/plain" }
      );
      return await response.text();
    } catch {
      // A candidate that cannot be read is skipped; another may match.
      return null;
    }
  }

  private async fetchRawBytes(
    source: string,
    commitSha: string,
    repoPath: string
  ): Promise<Uint8Array> {
    const response = await this.request(
      REGISTRY_SERVICES.GITHUB,
      this.rawUrl(source, commitSha, repoPath),
      `download of ${repoPath}`,
      { accept: "application/octet-stream" }
    );
    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * Audits for several skills from any {@link SkillsRegistry}, with bounded
 * concurrency. A failed lookup becomes that skill's `error`, never a throw.
 */
export async function fetchSkillAuditsBatch(
  registry: Pick<SkillsRegistry, "getSkillAudits">,
  skills: ReadonlyArray<{ source: string; slug: string }>
): Promise<RegistrySkillAuditResult[]> {
  return mapWithConcurrency(
    skills,
    AUDIT_CONCURRENCY,
    async ({ source, slug }) => {
      try {
        return {
          source,
          slug,
          audits: await registry.getSkillAudits(source, slug),
        };
      } catch (error) {
        return { source, slug, audits: null, error: getErrorMessage(error) };
      }
    }
  );
}

/** A {@link SkillUpdateCheck}, or why the check failed. */
export type SkillUpdateCheckOutcome =
  | SkillUpdateCheck
  | { status: typeof SKILL_UPDATE_STATUSES.FAILED; error: string };

/**
 * Update checks for several installed skills from any {@link SkillsRegistry},
 * in order, with bounded concurrency. A failed check becomes that skill's
 * `error`, never a throw.
 */
export async function checkSkillUpdatesBatch(
  registry: Pick<SkillsRegistry, "checkForUpdate">,
  skills: readonly InstalledRegistrySkill[]
): Promise<SkillUpdateCheckOutcome[]> {
  return mapWithConcurrency(
    skills,
    UPDATE_CHECK_CONCURRENCY,
    async (skill): Promise<SkillUpdateCheckOutcome> => {
      try {
        return await registry.checkForUpdate(skill);
      } catch (error) {
        return {
          status: SKILL_UPDATE_STATUSES.FAILED,
          error: getErrorMessage(error),
        };
      }
    }
  );
}
