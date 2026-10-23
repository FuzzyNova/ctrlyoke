import { useEffect, useMemo, useRef, useState } from "react";
import {
  SKILLS_REGISTRY_MIN_QUERY_LENGTH,
  SKILLS_REGISTRY_PAGE_SIZE,
  useSkillsRegistryStore,
  type RegistrySkillAuditState,
} from "@store/useSkillsRegistryStore";
import {
  DATA_SOURCES,
  KEYBOARD_KEYS,
  SKILL_AUDIT_STATUSES,
  SPECIAL_TARGET_IDS,
  getGitHubBlobUrl,
  getSkillsShAuditUrl,
  getSkillsShSkillUrl,
  type SettingWriteScope,
  type SkillAuditStatus,
} from "@root/types/DashboardConstants";
import type {
  ManagedFile,
  RegistrySkillAudit,
  RegistrySkillEntry,
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

function isInstalledInScope(
  managedFiles: readonly ManagedFile[],
  slug: string,
  scope: SettingWriteScope
): boolean {
  return managedFiles.some(
    (file) =>
      file.name === slug &&
      file.locations.some(
        (location) =>
          location.harnessId === SPECIAL_TARGET_IDS.CTRLYOKE &&
          location.scope === scope
      )
  );
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
  const isSearching = useSkillsRegistryStore((s) => s.isSearching);
  const searchError = useSkillsRegistryStore((s) => s.searchError);
  const page = useSkillsRegistryStore((s) => s.page);
  const setPage = useSkillsRegistryStore((s) => s.setPage);
  const audits = useSkillsRegistryStore((s) => s.audits);
  const requestAudits = useSkillsRegistryStore((s) => s.requestAudits);
  const openReview = useSkillsRegistryStore((s) => s.openReview);
  const reviewingKey = useSkillsRegistryStore((s) => s.reviewingKey);

  const lastSearchedQuery = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen || lastSearchedQuery.current === query) return;
    const handle = window.setTimeout(() => {
      lastSearchedQuery.current = query;
      search(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [isOpen, query, search]);

  const pageCount = results
    ? Math.max(1, Math.ceil(results.length / SKILLS_REGISTRY_PAGE_SIZE))
    : 0;
  const pageEntries = useMemo(
    () =>
      (results ?? []).slice(
        page * SKILLS_REGISTRY_PAGE_SIZE,
        (page + 1) * SKILLS_REGISTRY_PAGE_SIZE
      ),
    [results, page]
  );

  useEffect(() => {
    if (pageEntries.length > 0) requestAudits(pageEntries);
  }, [pageEntries, requestAudits]);

  const reviewingEntry = reviewingKey
    ? results?.find((entry) => entry.id === reviewingKey)
    : undefined;

  const searchNow = () => {
    lastSearchedQuery.current = query;
    search(query);
  };

  const trimmedQuery = query.trim();

  return (
    <div className="min-w-0 space-y-2">
      <div className="text-xxs font-semibold uppercase tracking-wide text-description-fg">
        Discover &amp; import
      </div>

      <div className="flex flex-wrap gap-1">
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
            ({SKILLS_SH.operator}), and your search text is sent there. Skills
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

          {isSearching ? (
            <div className="flex items-center gap-1.5 text-xs text-description-fg">
              <Icon name="loading" className="codicon-modifier-spin text-xxs" />
              Searching {SKILLS_SH.host}…
            </div>
          ) : searchError ? (
            <div className="text-xs text-error-fg">{searchError}</div>
          ) : trimmedQuery.length < SKILLS_REGISTRY_MIN_QUERY_LENGTH ? (
            <div className="text-xs text-description-fg italic">
              Type at least {SKILLS_REGISTRY_MIN_QUERY_LENGTH} characters to
              search {SKILLS_SH.label}.
            </div>
          ) : results && results.length > 0 ? (
            <>
              <div className="space-y-2">
                {pageEntries.map((entry) => {
                  const installed = isInstalledInScope(
                    managedFiles,
                    entry.slug,
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
                        disabled={installed}
                        onClick={() => openReview(entry)}
                        className="mt-0.5 rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        title={
                          installed
                            ? `Already in the ${activeScope} ctrlyoke skills folder`
                            : `Review and import ${entry.name} into ${activeScope}`
                        }
                      >
                        {installed ? "Imported" : "Import"}
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

      {reviewingEntry && (
        <SkillInstallReviewModal
          entry={reviewingEntry}
          activeScope={activeScope}
          skillsDirectory={skillsDirectory}
        />
      )}
    </div>
  );
}

function SkillInstallReviewModal({
  entry,
  activeScope,
  skillsDirectory,
}: {
  entry: RegistrySkillEntry;
  activeScope: SettingWriteScope;
  skillsDirectory?: string;
}) {
  const audit = useSkillsRegistryStore((s) => s.audits[entry.id]);
  const locationState = useSkillsRegistryStore((s) => s.locations[entry.id]);
  const installState = useSkillsRegistryStore((s) => s.installs[entry.id]);
  const install = useSkillsRegistryStore((s) => s.install);
  const closeReview = useSkillsRegistryStore((s) => s.closeReview);
  const [acknowledged, setAcknowledged] = useState(false);

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
    (!needsAcknowledgement || acknowledged);

  return (
    <ManagerConfirmModal
      title={`Install ${entry.name}?`}
      confirmLabel={isInstalling ? "Installing…" : "Install"}
      confirmDisabled={!canInstall}
      backdropLabel="Close install skill dialog"
      onCancel={closeReview}
      onConfirm={() => {
        if (location && canInstall) install(location, activeScope);
      }}
    >
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        <p>
          Installs <strong>{entry.slug}</strong> into the {activeScope} ctrlyoke
          skills folder
          {skillsDirectory ? (
            <>
              {" "}
              (<span className="break-all font-mono">{skillsDirectory}</span>)
            </>
          ) : null}
          . Use Save afterwards to copy it to a harness.
        </p>

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

        {installState?.error && (
          <div className="text-error-fg">{installState.error}</div>
        )}
      </div>
    </ManagerConfirmModal>
  );
}
