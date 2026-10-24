import { useEffect, useMemo, useRef, useState } from "react";
import {
  SKILLS_REGISTRY_MIN_INSTALLS_OPTIONS,
  SKILLS_REGISTRY_MIN_QUERY_LENGTH,
  SKILLS_REGISTRY_PAGE_SIZE,
  getRegistrySkillKey,
  useSkillsRegistryStore,
  type RegistrySkillAuditState,
  type RegistrySkillReview,
  type RegistrySkillReviewEntry,
  type RegistrySkillUpdateReview,
} from "@store/useSkillsRegistryStore";
import {
  DATA_SOURCES,
  KEYBOARD_KEYS,
  SKILL_AUDIT_STATUSES,
  SKILL_UPDATE_STATUSES,
  SPECIAL_TARGET_IDS,
  getGitHubBlobUrl,
  getGitHubCompareUrl,
  getSkillsShAuditUrl,
  getSkillsShSkillUrl,
  type SettingWriteScope,
  type SkillAuditStatus,
} from "@root/types/DashboardConstants";
import type {
  ManagedFile,
  ManagedFileLocation,
  RegistrySkillAudit,
  RegistrySkillEntry,
  SkillOriginInfo,
  SkillUpdateCheckResult,
} from "@root/types/WebviewMessageTypes";
import { ManagerConfirmModal } from "@components/shared/ManagerUi";
import { Icon } from "../shared/Icon";

const SKILLS_SH = DATA_SOURCES.SKILLS_SH;
const SEARCH_DEBOUNCE_MS = 400;

const installCountFormat = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatSkillInstalls(installs: number): string {
  return `${installCountFormat.format(installs)} install${installs === 1 ? "" : "s"} on ${SKILLS_SH.label}`;
}

const snapshotDateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
});

const AUDIT_STATUS_RANK: Record<SkillAuditStatus, number> = {
  [SKILL_AUDIT_STATUSES.PASS]: 0,
  [SKILL_AUDIT_STATUSES.WARN]: 1,
  [SKILL_AUDIT_STATUSES.FAIL]: 2,
};

/** The most severe audit, or `undefined` when there are none. */
export function getWorstSkillAudit(
  audits: readonly RegistrySkillAudit[]
): RegistrySkillAudit | undefined {
  return audits.reduce<RegistrySkillAudit | undefined>(
    (worst, audit) =>
      !worst ||
      AUDIT_STATUS_RANK[audit.status] > AUDIT_STATUS_RANK[worst.status]
        ? audit
        : worst,
    undefined
  );
}

/**
 * Whether installing needs the explicit second confirmation: any warning or
 * failure, no audit yet, or audits that could not be fetched.
 */
export function needsRiskAcknowledgement(
  audit: RegistrySkillAuditState | undefined
): boolean {
  if (!audit || audit.loading) return true;
  if (audit.error || audit.audits === null || audit.audits.length === 0) {
    return true;
  }
  return audit.audits.some(
    (entry) => entry.status !== SKILL_AUDIT_STATUSES.PASS
  );
}

/** Whether every audit provider passed the skill; unaudited does not count. */
export function hasPassedAudits(
  audit: RegistrySkillAuditState | undefined
): boolean {
  return Boolean(audit && !audit.loading) && !needsRiskAcknowledgement(audit);
}

/**
 * Results that clear the install floor and, when `auditsPassedOnly`, whose
 * audits have answered and all passed. `pendingAudits` counts the results
 * still waiting on their audits, which may yet appear.
 */
export function filterRegistrySkills(
  results: readonly RegistrySkillEntry[],
  audits: Readonly<Record<string, RegistrySkillAuditState>>,
  minInstalls: number,
  auditsPassedOnly: boolean
): { entries: RegistrySkillEntry[]; pendingAudits: number } {
  const byInstalls = results.filter((entry) => entry.installs >= minInstalls);
  if (!auditsPassedOnly) return { entries: byInstalls, pendingAudits: 0 };
  return {
    entries: byInstalls.filter((entry) => hasPassedAudits(audits[entry.id])),
    pendingAudits: byInstalls.filter((entry) => {
      const audit = audits[entry.id];
      return !audit || audit.loading;
    }).length,
  };
}

function formatMinInstalls(minInstalls: number): string {
  return minInstalls === 0
    ? "Any"
    : `${installCountFormat.format(minInstalls)}+`;
}

const FILTER_CHIP_CLASS =
  "rounded-sm border px-1.5 py-0 text-xxs transition-colors";
const FILTER_CHIP_ACTIVE_CLASS = "border-btn-bg bg-btn-bg text-btn-fg";
const FILTER_CHIP_INACTIVE_CLASS =
  "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground";

const AUDIT_STATUS_STYLES: Record<
  SkillAuditStatus,
  { icon: string; className: string; label: string }
> = {
  [SKILL_AUDIT_STATUSES.PASS]: {
    icon: "pass",
    className: "text-indicator-success",
    label: "Audits passed",
  },
  [SKILL_AUDIT_STATUSES.WARN]: {
    icon: "warning",
    className: "text-warning-fg",
    label: "Audit warning",
  },
  [SKILL_AUDIT_STATUSES.FAIL]: {
    icon: "error",
    className: "text-error-fg",
    label: "Audit failed",
  },
};

const PILL_CLASS =
  "inline-flex items-center gap-1 rounded-sm border border-panel-border px-1 py-0.5 text-xxs leading-none";

function AuditPill({
  entry,
  audit,
}: {
  entry: RegistrySkillEntry;
  audit: RegistrySkillAuditState | undefined;
}) {
  if (!audit || audit.loading) {
    return (
      <span className={`${PILL_CLASS} text-description-fg`}>
        <Icon name="loading" className="codicon-modifier-spin text-xxs" />
        Checking audits
      </span>
    );
  }
  if (audit.error) {
    return (
      <span className={`${PILL_CLASS} text-description-fg`} title={audit.error}>
        <Icon name="question" className="text-xxs" />
        Audits unavailable
      </span>
    );
  }
  const worst = audit.audits ? getWorstSkillAudit(audit.audits) : undefined;
  if (!worst) {
    return (
      <a
        href={getSkillsShSkillUrl(entry.source, entry.slug)}
        target="_blank"
        rel="noreferrer"
        className={`${PILL_CLASS} text-warning-fg hover:underline`}
        title={`${SKILLS_SH.label} has not audited this skill yet`}
      >
        <Icon name="shield" className="text-xxs" />
        Not audited
      </a>
    );
  }
  const style = AUDIT_STATUS_STYLES[worst.status];
  return (
    <a
      href={getSkillsShAuditUrl(entry.source, entry.slug, worst.providerSlug)}
      target="_blank"
      rel="noreferrer"
      className={`${PILL_CLASS} ${style.className} hover:underline`}
      title={`${style.label} on ${SKILLS_SH.label} (${worst.provider}${worst.riskLevel ? `: ${worst.riskLevel}` : ""}). Open the ${SKILLS_SH.label} security page.`}
    >
      <Icon name={style.icon} className="text-xxs" />
      {style.label}
    </a>
  );
}

/** The scope's ctrlyoke copy of a skill folder named `slug`, if any. */
function findCtrlYokeCopy(
  managedFiles: readonly ManagedFile[],
  slug: string,
  scope: SettingWriteScope
): ManagedFileLocation | undefined {
  return managedFiles
    .find((file) => file.name === slug)
    ?.locations.find(
      (location) =>
        location.harnessId === SPECIAL_TARGET_IDS.CTRLYOKE &&
        location.scope === scope
    );
}

/** The skills.sh origin of an installed copy, when it has one. */
function getSkillsShOrigin(
  location: ManagedFileLocation
): SkillOriginInfo | undefined {
  return location.origin?.registry === SKILLS_SH.host
    ? location.origin
    : undefined;
}

function isSameRegistrySkill(
  location: ManagedFileLocation,
  source: string,
  slug: string
): boolean {
  const origin = getSkillsShOrigin(location);
  return origin?.source === source && origin.slug === slug;
}

/** How many installed copies came from skills.sh, across both scopes. */
function countSkillsShCopies(managedFiles: readonly ManagedFile[]): number {
  return managedFiles.reduce(
    (count, file) =>
      count +
      file.locations.filter((location) => getSkillsShOrigin(location)).length,
    0
  );
}

/** Open the review dialog in update mode for an installed copy. */
function openUpdateReview(
  location: ManagedFileLocation,
  result: SkillUpdateCheckResult,
  name?: string
): void {
  const origin = getSkillsShOrigin(location);
  if (!origin) return;
  useSkillsRegistryStore.getState().openReview(
    {
      id: getRegistrySkillKey(origin.source, origin.slug),
      source: origin.source,
      slug: origin.slug,
      name: name ?? origin.slug,
    },
    {
      scope: location.scope,
      installedCommitSha: origin.commitSha,
      localChanges: result.localChanges,
    }
  );
}

const ORIGIN_BADGE_CLASS =
  "inline-flex items-center gap-1 rounded-sm border border-panel-border px-1 py-0.5 text-xxs leading-none";

/**
 * Shown beside a ctrlyoke copy's badge in the Agent & Skills Manager when it
 * was installed from skills.sh, with that copy's last update check result.
 */
export function SkillOriginBadge({
  location,
  name,
}: {
  location: ManagedFileLocation;
  name?: string;
}) {
  const result = useSkillsRegistryStore(
    (s) => s.updateCheck.results[location.path]
  );
  const origin = getSkillsShOrigin(location);
  if (!origin) return null;
  return (
    <>
      <a
        href={getSkillsShSkillUrl(origin.source, origin.slug)}
        target="_blank"
        rel="noreferrer"
        className={`${ORIGIN_BADGE_CLASS} text-description-fg hover:underline`}
        title={`Installed from ${SKILLS_SH.label}: github.com/${origin.source} at commit ${origin.commitSha.slice(0, 7)}`}
      >
        <Icon name="globe" className="text-xxs" />
        {SKILLS_SH.label}
      </a>
      {result?.status === SKILL_UPDATE_STATUSES.UPDATE_AVAILABLE && (
        <button
          type="button"
          onClick={() => openUpdateReview(location, result, name)}
          className={`${ORIGIN_BADGE_CLASS} border-btn-bg bg-btn-bg text-btn-fg hover:bg-btn-hover`}
          title={`Review and install the newest version from github.com/${origin.source}`}
        >
          <Icon name="arrow-circle-up" className="text-xxs" />
          Update available
        </button>
      )}
      {result?.status === SKILL_UPDATE_STATUSES.NOT_FOUND && (
        <span
          className={`${ORIGIN_BADGE_CLASS} text-warning-fg`}
          title={`github.com/${origin.source} no longer contains this skill`}
        >
          <Icon name="warning" className="text-xxs" />
          Removed upstream
        </span>
      )}
      {result?.status === SKILL_UPDATE_STATUSES.FAILED && (
        <span
          className={`${ORIGIN_BADGE_CLASS} text-description-fg`}
          title={result.error}
        >
          <Icon name="question" className="text-xxs" />
          Update check failed
        </span>
      )}
    </>
  );
}

/** "Check for updates" and the outcome of the last check. */
function SkillUpdateCheckControl({ copies }: { copies: number }) {
  const updateCheck = useSkillsRegistryStore((s) => s.updateCheck);
  const checkForUpdates = useSkillsRegistryStore((s) => s.checkForUpdates);
  const results = Object.values(updateCheck.results);
  const available = results.filter(
    (result) => result.status === SKILL_UPDATE_STATUSES.UPDATE_AVAILABLE
  ).length;
  const failures = results.filter(
    (result) => result.status === SKILL_UPDATE_STATUSES.FAILED
  );

  let summary: string | undefined;
  if (updateCheck.checking) {
    summary = `Checking ${copies} skill${copies === 1 ? "" : "s"} on GitHub…`;
  } else if (updateCheck.checkedAt !== undefined) {
    summary =
      available > 0
        ? `${available} update${available === 1 ? "" : "s"} available`
        : failures.length === 0
          ? "Up to date"
          : undefined;
    if (failures.length > 0) {
      const failed = `${failures.length} check${failures.length === 1 ? "" : "s"} failed`;
      summary = summary ? `${summary}, ${failed}` : failed;
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={checkForUpdates}
        disabled={updateCheck.checking}
        title={`Compare the ${copies} skill${copies === 1 ? "" : "s"} installed from ${SKILLS_SH.label} with their GitHub repositories`}
        className="flex items-center gap-1 rounded-sm border border-panel-border px-2 py-1 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon
          name={updateCheck.checking ? "loading" : "refresh"}
          className={`text-xxs ${updateCheck.checking ? "codicon-modifier-spin" : ""}`}
        />
        Check for updates
      </button>
      {summary && (
        <span
          className="text-xxs text-description-fg"
          title={
            failures
              .map((result) => `${result.slug}: ${result.error}`)
              .join("\n") || undefined
          }
          role="status"
        >
          {summary}
        </span>
      )}
    </div>
  );
}

/** The action a search result offers, given what the scope already holds. */
function getResultAction(
  entry: RegistrySkillEntry,
  copy: ManagedFileLocation | undefined,
  updateResult: SkillUpdateCheckResult | undefined,
  scope: SettingWriteScope
): { label: string; title: string; onClick?: () => void } {
  if (!copy) {
    return {
      label: "Import",
      title: `Review and import ${entry.name} into ${scope}`,
      onClick: () => useSkillsRegistryStore.getState().openReview(entry),
    };
  }
  if (!isSameRegistrySkill(copy, entry.source, entry.slug)) {
    return {
      label: "Name in use",
      title: `A different skill named ${entry.slug} is already in the ${scope} ctrlyoke skills folder. Delete or rename it to import this one.`,
    };
  }
  if (updateResult?.status === SKILL_UPDATE_STATUSES.UPDATE_AVAILABLE) {
    return {
      label: "Update",
      title: `Review and install the newest version of ${entry.name}`,
      onClick: () => openUpdateReview(copy, updateResult, entry.name),
    };
  }
  return {
    label: "Installed",
    title: `Already in the ${scope} ctrlyoke skills folder. Use Check for updates to compare it with GitHub.`,
  };
}

type SkillsRegistryPanelProps = {
  activeScope: SettingWriteScope;
  managedFiles: readonly ManagedFile[];
  /** The active scope's ctrlyoke skills folder, shown in the install dialog. */
  skillsDirectory?: string;
};

/**
 * The Agent & Skills Manager's "Discover & import" area for skills: search
 * skills.sh and install a reviewed skill into the active scope's ctrlyoke
 * skills folder. Nothing is fetched until the user opens the skills.sh tab.
 */
export function SkillsRegistryPanel({
  activeScope,
  managedFiles,
  skillsDirectory,
}: SkillsRegistryPanelProps) {
  const isOpen = useSkillsRegistryStore((s) => s.isOpen);
  const setOpen = useSkillsRegistryStore((s) => s.setOpen);
  const query = useSkillsRegistryStore((s) => s.query);
  const setQuery = useSkillsRegistryStore((s) => s.setQuery);
  const search = useSkillsRegistryStore((s) => s.search);
  const results = useSkillsRegistryStore((s) => s.results);
  const isTop = useSkillsRegistryStore((s) => s.isTop);
  const topSnapshotDate = useSkillsRegistryStore((s) => s.topSnapshotDate);
  const minInstalls = useSkillsRegistryStore((s) => s.minInstalls);
  const setMinInstalls = useSkillsRegistryStore((s) => s.setMinInstalls);
  const auditsPassedOnly = useSkillsRegistryStore((s) => s.auditsPassedOnly);
  const setAuditsPassedOnly = useSkillsRegistryStore(
    (s) => s.setAuditsPassedOnly
  );
  const isSearching = useSkillsRegistryStore((s) => s.isSearching);
  const searchError = useSkillsRegistryStore((s) => s.searchError);
  const page = useSkillsRegistryStore((s) => s.page);
  const setPage = useSkillsRegistryStore((s) => s.setPage);
  const audits = useSkillsRegistryStore((s) => s.audits);
  const requestAudits = useSkillsRegistryStore((s) => s.requestAudits);
  const review = useSkillsRegistryStore((s) => s.review);
  const updateResults = useSkillsRegistryStore((s) => s.updateCheck.results);
  const skillsShCopies = useMemo(
    () => countSkillsShCopies(managedFiles),
    [managedFiles]
  );

  const lastSearchedQuery = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen || lastSearchedQuery.current === query) return;
    // Opening the tab shows the bundled top skills straight away; typing is
    // debounced.
    const delayMs =
      lastSearchedQuery.current === null && !query.trim()
        ? 0
        : SEARCH_DEBOUNCE_MS;
    const handle = window.setTimeout(() => {
      lastSearchedQuery.current = query;
      search(query);
    }, delayMs);
    return () => window.clearTimeout(handle);
  }, [isOpen, query, search]);

  const { entries: filteredResults, pendingAudits } = useMemo(
    () =>
      filterRegistrySkills(
        results ?? [],
        audits,
        minInstalls,
        auditsPassedOnly
      ),
    [results, audits, minInstalls, auditsPassedOnly]
  );

  const pageCount = Math.ceil(
    filteredResults.length / SKILLS_REGISTRY_PAGE_SIZE
  );
  const pageEntries = useMemo(
    () =>
      filteredResults.slice(
        page * SKILLS_REGISTRY_PAGE_SIZE,
        (page + 1) * SKILLS_REGISTRY_PAGE_SIZE
      ),
    [filteredResults, page]
  );

  // "Audits passed" can only filter results whose audits have answered, so
  // it asks for every result's audits; otherwise only the visible page's.
  const auditTargets = useMemo(
    () =>
      auditsPassedOnly
        ? (results ?? []).filter((entry) => entry.installs >= minInstalls)
        : pageEntries,
    [auditsPassedOnly, results, minInstalls, pageEntries]
  );

  useEffect(() => {
    if (auditTargets.length > 0) requestAudits(auditTargets);
  }, [auditTargets, requestAudits]);

  const searchNow = () => {
    lastSearchedQuery.current = query;
    search(query);
  };

  const trimmedQuery = query.trim();
  const hasResults = Boolean(results && results.length > 0);

  return (
    <div className="min-w-0 space-y-2">
      <div className="text-xxs font-semibold uppercase tracking-wide text-description-fg">
        Discover &amp; import
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(!isOpen)}
          aria-expanded={isOpen}
          title={`Search the public ${SKILLS_SH.label} skills directory run by ${SKILLS_SH.operator}`}
          className={`flex items-center gap-1 rounded-sm border px-2 py-1 text-xs transition-colors ${
            isOpen
              ? "border-btn-bg bg-btn-bg text-btn-fg"
              : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
          }`}
        >
          <Icon name="globe" className="text-xxs" />
          {SKILLS_SH.label}
        </button>
        {skillsShCopies > 0 && (
          <SkillUpdateCheckControl copies={skillsShCopies} />
        )}
      </div>

      {isOpen && (
        <div className="space-y-2 rounded-sm border border-panel-border bg-editor-bg p-3">
          <p className="text-xs text-description-fg">
            Results, install counts and security audits come from{" "}
            <a
              href={SKILLS_SH.url}
              target="_blank"
              rel="noreferrer"
              className="text-link-fg hover:underline"
            >
              {SKILLS_SH.host}
            </a>{" "}
            ({SKILLS_SH.operator}), and your search text is sent there. The list
            shown before you search is a snapshot bundled with ctrlyoke. Skills
            are published by third parties and are downloaded from their GitHub
            repositories when you install one, so review a skill before you
            install it.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === KEYBOARD_KEYS.ENTER) {
                  event.preventDefault();
                  searchNow();
                }
              }}
              placeholder={`Search ${SKILLS_SH.label}…`}
              aria-label={`Search ${SKILLS_SH.label}`}
              className="min-w-[220px] flex-1 rounded-sm border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg focus:border-focus-border focus:outline-hidden"
            />
            <button
              type="button"
              onClick={searchNow}
              disabled={
                isSearching ||
                trimmedQuery.length < SKILLS_REGISTRY_MIN_QUERY_LENGTH
              }
              className="rounded-sm border border-panel-border px-2 py-1 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              Search
            </button>
          </div>

          {!isSearching && !searchError && hasResults && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xxs text-description-fg">Installs:</span>
              {SKILLS_REGISTRY_MIN_INSTALLS_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMinInstalls(option)}
                  aria-pressed={minInstalls === option}
                  title={
                    option === 0
                      ? "Show skills with any install count"
                      : `Show skills with at least ${option.toLocaleString("en")} installs on ${SKILLS_SH.label}`
                  }
                  className={`${FILTER_CHIP_CLASS} ${
                    minInstalls === option
                      ? FILTER_CHIP_ACTIVE_CLASS
                      : FILTER_CHIP_INACTIVE_CLASS
                  }`}
                >
                  {formatMinInstalls(option)}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setAuditsPassedOnly(!auditsPassedOnly)}
                aria-pressed={auditsPassedOnly}
                title={`Show only skills that every ${SKILLS_SH.label} audit provider passed. Fetches the audits of every result.`}
                className={`ml-1 flex items-center gap-1 ${FILTER_CHIP_CLASS} ${
                  auditsPassedOnly
                    ? FILTER_CHIP_ACTIVE_CLASS
                    : FILTER_CHIP_INACTIVE_CLASS
                }`}
              >
                <Icon name="pass" className="text-xxs" />
                Audits passed
              </button>
            </div>
          )}

          {isSearching ? (
            <div className="flex items-center gap-1.5 text-xs text-description-fg">
              <Icon name="loading" className="codicon-modifier-spin text-xxs" />
              {isTop ? "Loading top skills…" : `Searching ${SKILLS_SH.host}…`}
            </div>
          ) : searchError ? (
            <div className="text-xs text-error-fg">{searchError}</div>
          ) : isTop && !hasResults ? (
            <div className="text-xs text-description-fg italic">
              Type at least {SKILLS_REGISTRY_MIN_QUERY_LENGTH} characters to
              search {SKILLS_SH.label}.
            </div>
          ) : hasResults ? (
            <>
              {isTop && (
                <div
                  className="text-xxs font-semibold uppercase tracking-wide text-description-fg"
                  title={`A snapshot of the ${SKILLS_SH.label} all-time leaderboard bundled with ctrlyoke. Install counts are as of that date; search for live results.`}
                >
                  Top skills on {SKILLS_SH.label}
                  {topSnapshotDate
                    ? ` · as of ${snapshotDateFormat.format(new Date(topSnapshotDate))}`
                    : ""}
                </div>
              )}
              {pendingAudits > 0 && (
                <div
                  className="flex items-center gap-1.5 text-xxs text-description-fg"
                  role="status"
                >
                  <Icon
                    name="loading"
                    className="codicon-modifier-spin text-xxs"
                  />
                  Checking audits for {pendingAudits} more skill
                  {pendingAudits === 1 ? "" : "s"}…
                </div>
              )}
              {filteredResults.length === 0 && pendingAudits === 0 && (
                <div className="text-xs text-description-fg italic">
                  No {isTop ? "top skills" : "results"} match these filters.
                </div>
              )}
              <div className="space-y-2">
                {pageEntries.map((entry) => {
                  const copy = findCtrlYokeCopy(
                    managedFiles,
                    entry.slug,
                    activeScope
                  );
                  const action = getResultAction(
                    entry,
                    copy,
                    copy ? updateResults[copy.path] : undefined,
                    activeScope
                  );
                  return (
                    <div
                      key={entry.id}
                      className="flex items-start justify-between gap-2 rounded-sm border border-panel-border px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <a
                          href={getSkillsShSkillUrl(entry.source, entry.slug)}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate text-xs font-medium text-foreground hover:underline"
                          title={`Open ${entry.name} on ${SKILLS_SH.label}`}
                        >
                          {entry.name}
                        </a>
                        <div className="truncate font-mono text-xxs text-description-fg">
                          {entry.source}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xxs text-description-fg">
                          <span>{formatSkillInstalls(entry.installs)}</span>
                          <AuditPill entry={entry} audit={audits[entry.id]} />
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={!action.onClick}
                        onClick={action.onClick}
                        className="mt-0.5 shrink-0 rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        title={action.title}
                      >
                        {action.label}
                      </button>
                    </div>
                  );
                })}
              </div>

              {pageCount > 1 && (
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setPage(page - 1)}
                    disabled={page === 0}
                    className="flex items-center gap-1 rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <Icon name="chevron-left" className="text-xxs" />
                    Prev
                  </button>
                  <span className="text-xxs text-description-fg">
                    Page {page + 1} of {pageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage(page + 1)}
                    disabled={page >= pageCount - 1}
                    className="flex items-center gap-1 rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    Next
                    <Icon name="chevron-right" className="text-xxs" />
                  </button>
                </div>
              )}
            </>
          ) : results ? (
            <div className="text-xs text-description-fg italic">
              No skills on {SKILLS_SH.label} match “{trimmedQuery}”.
            </div>
          ) : null}
        </div>
      )}

      {review && (
        <SkillInstallReviewModal
          review={review}
          activeScope={activeScope}
          skillsDirectory={skillsDirectory}
        />
      )}
    </div>
  );
}

/** Local changes listed by name in the update dialog; the rest are counted. */
const MAX_LISTED_LOCAL_CHANGES = 8;

function SkillInstallReviewModal({
  review,
  activeScope,
  skillsDirectory,
}: {
  review: RegistrySkillReview;
  activeScope: SettingWriteScope;
  skillsDirectory?: string;
}) {
  const { entry, update } = review;
  const audit = useSkillsRegistryStore((s) => s.audits[entry.id]);
  const locationState = useSkillsRegistryStore((s) => s.locations[entry.id]);
  const installState = useSkillsRegistryStore((s) => s.installs[entry.id]);
  const install = useSkillsRegistryStore((s) => s.install);
  const closeReview = useSkillsRegistryStore((s) => s.closeReview);
  const [acknowledged, setAcknowledged] = useState(false);
  const [discardLocalChanges, setDiscardLocalChanges] = useState(false);

  const scope = update?.scope ?? activeScope;
  const localChanges = update?.localChanges ?? [];
  const location =
    locationState && !locationState.loading
      ? locationState.location
      : undefined;
  const auditResult = audit && !audit.loading ? audit : undefined;
  const isInstalling = Boolean(installState?.installing);
  const needsAcknowledgement = needsRiskAcknowledgement(audit);
  const canInstall =
    Boolean(location) &&
    !isInstalling &&
    Boolean(auditResult) &&
    (!needsAcknowledgement || acknowledged) &&
    (localChanges.length === 0 || discardLocalChanges);

  return (
    <ManagerConfirmModal
      title={`${update ? "Update" : "Install"} ${entry.name}?`}
      confirmLabel={
        update
          ? isInstalling
            ? "Updating…"
            : "Update"
          : isInstalling
            ? "Installing…"
            : "Install"
      }
      confirmDisabled={!canInstall}
      backdropLabel={`Close ${update ? "update" : "install"} skill dialog`}
      onCancel={closeReview}
      onConfirm={() => {
        if (location && canInstall) install(location, scope, Boolean(update));
      }}
    >
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        {update ? (
          <UpdateSummary
            entry={entry}
            update={update}
            latestCommitSha={location?.commitSha}
          />
        ) : (
          <p>
            Installs <strong>{entry.slug}</strong> into the {scope} ctrlyoke
            skills folder
            {skillsDirectory ? (
              <>
                {" "}
                (<span className="break-all font-mono">{skillsDirectory}</span>)
              </>
            ) : null}
            . Use Save afterwards to copy it to a harness.
          </p>
        )}

        {localChanges.length > 0 && (
          <div className="space-y-1 text-warning-fg">
            <p>
              You changed {localChanges.length} file
              {localChanges.length === 1 ? "" : "s"} in this skill since
              installing it. Updating replaces{" "}
              {localChanges.length === 1 ? "it" : "them"}:
            </p>
            <ul className="list-disc pl-4 font-mono">
              {localChanges.slice(0, MAX_LISTED_LOCAL_CHANGES).map((file) => (
                <li key={file} className="break-all">
                  {file}
                </li>
              ))}
              {localChanges.length > MAX_LISTED_LOCAL_CHANGES && (
                <li>
                  and {localChanges.length - MAX_LISTED_LOCAL_CHANGES} more
                </li>
              )}
            </ul>
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xxs font-semibold uppercase tracking-wide">
            Files from GitHub
          </div>
          {!locationState || locationState.loading ? (
            <div className="flex items-center gap-1.5">
              <Icon name="loading" className="codicon-modifier-spin text-xxs" />
              Locating the skill in github.com/{entry.source}…
            </div>
          ) : location ? (
            <div>
              <a
                href={getGitHubBlobUrl(
                  location.source,
                  location.commitSha,
                  location.skillMdPath
                )}
                target="_blank"
                rel="noreferrer"
                className="break-all font-mono text-link-fg hover:underline"
              >
                github.com/{location.source}/{location.skillMdPath}
              </a>{" "}
              at commit{" "}
              <span className="font-mono">
                {location.commitSha.slice(0, 7)}
              </span>
              {location.description && (
                <p className="mt-1 line-clamp-3">{location.description}</p>
              )}
            </div>
          ) : (
            <div className="text-error-fg">{locationState.error}</div>
          )}
        </div>

        <div className="space-y-1">
          <div className="text-xxs font-semibold uppercase tracking-wide">
            Security audits from {SKILLS_SH.label}
          </div>
          {!auditResult ? (
            <div className="flex items-center gap-1.5">
              <Icon name="loading" className="codicon-modifier-spin text-xxs" />
              Fetching audits from {SKILLS_SH.host}…
            </div>
          ) : auditResult.error ? (
            <div className="text-error-fg">{auditResult.error}</div>
          ) : !auditResult.audits || auditResult.audits.length === 0 ? (
            <div className="text-warning-fg">
              {SKILLS_SH.label} has not audited this skill yet.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {auditResult.audits.map((item) => {
                const style = AUDIT_STATUS_STYLES[item.status];
                return (
                  <li key={item.providerSlug}>
                    <div className="flex items-center gap-1">
                      <Icon
                        name={style.icon}
                        className={`text-xxs ${style.className}`}
                      />
                      <a
                        href={getSkillsShAuditUrl(
                          entry.source,
                          entry.slug,
                          item.providerSlug
                        )}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-link-fg hover:underline"
                      >
                        {item.provider}
                      </a>
                      <span className={style.className}>{item.status}</span>
                      {item.riskLevel && <span>· {item.riskLevel}</span>}
                    </div>
                    {item.summary && (
                      <p className="line-clamp-2" title={item.summary}>
                        {item.summary}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {needsAcknowledgement && auditResult && (
          <label className="flex items-start gap-1.5 text-foreground">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-focus-border"
            />
            <span>
              This skill has audit warnings or has not been audited. I have
              reviewed its files and want to install it anyway.
            </span>
          </label>
        )}

        {localChanges.length > 0 && (
          <label className="flex items-start gap-1.5 text-foreground">
            <input
              type="checkbox"
              checked={discardLocalChanges}
              onChange={(event) => setDiscardLocalChanges(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-focus-border"
            />
            <span>Replace my local changes.</span>
          </label>
        )}

        {installState?.error && (
          <div className="text-error-fg">{installState.error}</div>
        )}
      </div>
    </ManagerConfirmModal>
  );
}

/** What an update replaces, with a link to the changes on GitHub. */
function UpdateSummary({
  entry,
  update,
  latestCommitSha,
}: {
  entry: RegistrySkillReviewEntry;
  update: RegistrySkillUpdateReview;
  latestCommitSha: string | undefined;
}) {
  return (
    <p>
      Replaces the {update.scope} copy of <strong>{entry.slug}</strong>,
      installed from commit{" "}
      <span className="font-mono">{update.installedCommitSha.slice(0, 7)}</span>
      , with the files below.{" "}
      {latestCommitSha && latestCommitSha !== update.installedCommitSha && (
        <>
          <a
            href={getGitHubCompareUrl(
              entry.source,
              update.installedCommitSha,
              latestCommitSha
            )}
            target="_blank"
            rel="noreferrer"
            className="text-link-fg hover:underline"
          >
            Compare the commits on GitHub
          </a>
          .{" "}
        </>
      )}
      Copies saved to harness folders keep the old version until you Save again.
    </p>
  );
}
