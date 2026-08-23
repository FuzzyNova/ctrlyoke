import React from "react";
import { useLongPress } from "@hooks/useLongPress";
import type { FailedWorkspaceDirectoryRange } from "@hooks/usePagedWorkspaceDirectory";
import type {
  WorkspaceEntry,
  WorkspaceEntrySort,
  WorkspaceEntrySortKey,
} from "@root/types/HostedWorkspaceViewerTypes";
import {
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
} from "@root/types/HostedWorkspaceViewerTypes";

/**
 * Shared tracks keep the sort header and every entry row aligned. At the
 * normal tier the date column is sized to the compact formatter's output,
 * not a large percentage of the row, so wide panes give the name column its
 * space back instead of leaving blank room to the right of the date text.
 * The narrow variant shrinks the date column further still — it pairs with
 * `formatWorkspaceEntryModifiedAt`'s narrow (date-only) text below — because
 * below `FILE_BROWSER_NARROW_THRESHOLD` there isn't room for both a readable
 * name and a full date/time; the name wins and the date degrades gracefully
 * rather than the reverse. The full date/time is never lost — it's always in
 * the row's title/aria-label.
 */
export const FILE_BROWSER_GRID_TEMPLATE =
  "1.25rem minmax(0, 1fr) clamp(6.25rem, 22%, 7.5rem)";
export const FILE_BROWSER_GRID_TEMPLATE_NARROW =
  "1.25rem minmax(0, 1fr) clamp(2.5rem, 16%, 3.5rem)";

/**
 * Width (px) below which a file browser column layout switches to the
 * narrow tier. The default panel width (256px, see `constants.ts`) and
 * common mobile viewports both fall under this — the narrow tier is the
 * common case; the wide tier is what a manually-widened panel gets.
 */
export const FILE_BROWSER_NARROW_THRESHOLD = 440;

const modifiedAtCompactFormatter = new Intl.DateTimeFormat(undefined, {
  year: "2-digit",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const modifiedAtNarrowFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
});
const modifiedAtFullFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "long",
});

export interface WorkspaceEntryModifiedAtPresentation {
  compact: string;
  full: string;
}

/**
 * Format a workspace entry timestamp for both its visible cell and its full
 * tooltip/accessibility value. Filesystem metadata is best-effort, so invalid
 * and absent timestamps deliberately share the same safe fallback.
 *
 * `isNarrow` drops the compact value to date-only (no year, no time) so the
 * narrow grid column never needs to truncate mid-string; the full value
 * (used in tooltips/aria-labels) is unaffected.
 */
export function formatWorkspaceEntryModifiedAt(
  modifiedAt: number | undefined,
  isNarrow: boolean = false
): WorkspaceEntryModifiedAtPresentation {
  if (modifiedAt === undefined || !Number.isFinite(modifiedAt)) {
    return { compact: "—", full: "—" };
  }

  const date = new Date(modifiedAt);
  if (Number.isNaN(date.getTime())) {
    return { compact: "—", full: "—" };
  }

  return {
    compact: (isNarrow
      ? modifiedAtNarrowFormatter
      : modifiedAtCompactFormatter
    ).format(date),
    full: modifiedAtFullFormatter.format(date),
  };
}

const SORT_LABELS: Record<WorkspaceEntrySortKey, string> = {
  [WORKSPACE_ENTRY_SORT_KEYS.NAME]: "Name",
  [WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT]: "Date modified",
};
const SORT_LABELS_NARROW: Record<WorkspaceEntrySortKey, string> = {
  [WORKSPACE_ENTRY_SORT_KEYS.NAME]: "Name",
  [WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT]: "Date",
};

function sortDirectionLabel(sort: WorkspaceEntrySort): string {
  return sort.direction === WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING
    ? "ascending"
    : "descending";
}

export interface FileBrowserSortHeaderProps {
  sort: WorkspaceEntrySort;
  onSortKeyRequest: (key: WorkspaceEntrySortKey) => void;
  /** Defaults to false. See `FILE_BROWSER_NARROW_THRESHOLD`. */
  isNarrow?: boolean;
}

/** Shared, stateless sort controls for the workspace file browsers. */
export function FileBrowserSortHeader({
  sort,
  onSortKeyRequest,
  isNarrow = false,
}: FileBrowserSortHeaderProps): React.ReactElement {
  const renderSortButton = (key: WorkspaceEntrySortKey): React.ReactElement => {
    const isActive = sort.key === key;
    // Visible text shrinks at the narrow tier; the accessible name stays
    // full-length regardless of how much of it is visually truncated.
    const fullLabel = SORT_LABELS[key];
    const visibleLabel = (isNarrow ? SORT_LABELS_NARROW : SORT_LABELS)[key];
    const direction = sortDirectionLabel(sort);
    const activationDirection =
      key === WORKSPACE_ENTRY_SORT_KEYS.NAME ? "ascending" : "descending";
    const accessibleDirection = isActive
      ? `currently ${direction}`
      : `inactive; selecting sorts ${activationDirection}`;

    return (
      <button
        key={key}
        type="button"
        aria-label={`${fullLabel}, ${accessibleDirection}`}
        aria-pressed={isActive}
        onClick={() => onSortKeyRequest(key)}
        className="flex min-w-0 items-center gap-1 truncate rounded px-1 py-1 text-left text-xs font-medium text-description-fg hover:bg-btn-secondary-hover hover:text-editor-fg"
      >
        <span className="truncate">{visibleLabel}</span>
        {isActive && (
          <i
            aria-hidden="true"
            className={`codicon flex-shrink-0 ${
              sort.direction === WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING
                ? "codicon-chevron-up"
                : "codicon-chevron-down"
            }`}
          />
        )}
      </button>
    );
  };

  return (
    <div
      data-testid="file-browser-sort-header"
      className="grid w-full items-center gap-1.5 border-b border-panel-border px-3 py-1 text-xs"
      style={{
        gridTemplateColumns: isNarrow
          ? FILE_BROWSER_GRID_TEMPLATE_NARROW
          : FILE_BROWSER_GRID_TEMPLATE,
      }}
    >
      <span aria-hidden="true" />
      {renderSortButton(WORKSPACE_ENTRY_SORT_KEYS.NAME)}
      {renderSortButton(WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT)}
    </div>
  );
}

/**
 * Strip a workspace root prefix from an absolute path, returning a
 * workspace-relative path. Returns the original string unchanged when the
 * path is already relative or when workspaceRoot is not set.
 * Handles mixed forward-/back-slash separators (Windows paths sent over HTTP).
 * Uses case-insensitive comparison to tolerate drive-letter casing differences
 * (VS Code's uri.fsPath may return "c:\..." while AI output uses "C:/...").
 */
export function toWorkspaceRelative(
  filePath: string,
  workspaceRoot: string | null | undefined
): string {
  if (!workspaceRoot || !filePath) return filePath.replace(/\\/g, "/");
  const norm = filePath.replace(/\\/g, "/");
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
  // Case-insensitive comparison: Windows paths are case-insensitive, and
  // VS Code uri.fsPath may differ in drive letter or folder casing from
  // paths generated by the AI or Node.js path.resolve.
  if (norm.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return norm.slice(root.length + 1);
  }
  // Always return forward-slash normalized path so that selectedFilePath is
  // consistent regardless of whether filePath was absolute or already relative.
  return norm;
}

export interface EntryRowProps {
  entry: WorkspaceEntry;
  isSelected: boolean;
  /** Prevents selection while preserving the shared row's native button semantics. */
  disabled?: boolean;
  /** Defaults to false — only the explorer's cut/paste feature needs this. */
  isCut?: boolean;
  statusColorClass: string | undefined;
  onClick: () => void;
  /** Defaults to a no-op — only the explorer's right-click/long-press context menu needs this. */
  openContextMenu?: (x: number, y: number, entry: WorkspaceEntry) => void;
  /** Defaults to false. See `FILE_BROWSER_NARROW_THRESHOLD`. */
  isNarrow?: boolean;
}

const noopOpenContextMenu = () => {};

export function EntryRow({
  entry,
  isSelected,
  disabled = false,
  isCut = false,
  statusColorClass,
  onClick,
  openContextMenu = noopOpenContextMenu,
  isNarrow = false,
}: EntryRowProps) {
  const longPressHandlers = useLongPress((x, y) =>
    openContextMenu(x, y, entry)
  );
  const modifiedAt = formatWorkspaceEntryModifiedAt(entry.modifiedAt, isNarrow);
  const entryLabel = `${entry.name}${entry.kind === "directory" ? "/" : ""}, ${entry.path}, modified ${modifiedAt.full}`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, entry);
      }}
      {...longPressHandlers}
      className={`fp-list-row grid w-full min-w-0 items-center gap-1.5 px-3 py-1 min-h-[44px] sm:min-h-0 text-sm text-left transition-colors ${
        isSelected
          ? "fp-list-row-selected bg-list-active-bg text-editor-fg"
          : disabled
            ? "text-editor-fg"
            : "text-editor-fg hover:bg-list-hover-bg"
      }`}
      style={{
        ...(isCut ? { opacity: 0.5 } : {}),
        gridTemplateColumns: isNarrow
          ? FILE_BROWSER_GRID_TEMPLATE_NARROW
          : FILE_BROWSER_GRID_TEMPLATE,
      }}
      title={`${entry.path} — Modified ${modifiedAt.full}`}
      aria-label={entryLabel}
    >
      <i
        aria-hidden="true"
        className={`codicon text-sm ${
          entry.kind === "directory"
            ? "codicon-folder text-[var(--status-warning)]"
            : "codicon-file"
        }`}
      />
      <span className={`min-w-0 truncate ${statusColorClass ?? ""}`}>
        {entry.name}
        {entry.kind === "directory" ? "/" : ""}
      </span>
      <span
        className="min-w-0 truncate whitespace-nowrap text-xs text-description-fg"
        title={modifiedAt.full}
      >
        {modifiedAt.compact}
      </span>
    </button>
  );
}

export interface DirectoryPageFailureNoticeProps {
  failedRange: FailedWorkspaceDirectoryRange | undefined;
  onRetry: (offset: number) => void;
}

/**
 * Persistent recovery control for a failed sparse page. Keeping this outside
 * the virtual rows makes Retry reachable even when the page's first absolute
 * index is outside the mounted overscan range after a direct scrollbar jump.
 */
export function DirectoryPageFailureNotice({
  failedRange,
  onRetry,
}: DirectoryPageFailureNoticeProps): React.ReactElement | null {
  if (!failedRange) return null;

  return (
    <div
      role="alert"
      className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-panel-border px-3 py-1.5 text-sm text-warning-fg"
    >
      <span>
        Unable to load entries {failedRange.offset + 1}–
        {failedRange.endOffset.toLocaleString()}.
      </span>
      <button
        type="button"
        className="rounded border border-btn-border px-2 py-1 hover:bg-btn-secondary-hover"
        onClick={() => onRetry(failedRange.offset)}
      >
        Retry / Load page
      </button>
    </div>
  );
}

/**
 * Build breadcrumb segments for a workspace-relative directory path.
 * Handles both forward-slash and backslash separators.
 */
export function renderBreadcrumb(
  explorerPath: string,
  rootLabel: string,
  onNavigate: (path: string) => void
): React.ReactNode[] {
  const sep = explorerPath.includes("\\") ? "\\" : "/";
  const segments = explorerPath
    ? explorerPath.split(/[/\\]/).filter(Boolean)
    : [];
  const crumbs: React.ReactNode[] = [
    <button
      key="root"
      onClick={() => onNavigate("")}
      className="max-w-full truncate whitespace-nowrap hover:underline text-editor-fg opacity-70 hover:opacity-100 text-xs"
      title="Go to workspace root"
    >
      {rootLabel || "workspace"}
    </button>,
  ];

  segments.forEach((segment, i) => {
    const segPath = segments.slice(0, i + 1).join(sep);
    const isLast = i === segments.length - 1;
    crumbs.push(
      <span
        key={`sep-${i}`}
        className="whitespace-nowrap opacity-40 text-xs mx-0.5 select-none"
      >
        /
      </span>
    );
    if (isLast) {
      crumbs.push(
        <span
          key={segPath}
          className="max-w-full truncate whitespace-nowrap text-editor-fg text-xs font-medium"
        >
          {segment}
        </span>
      );
    } else {
      crumbs.push(
        <button
          key={segPath}
          onClick={() => onNavigate(segPath)}
          className="max-w-full truncate whitespace-nowrap hover:underline text-editor-fg opacity-70 hover:opacity-100 text-xs"
        >
          {segment}
        </button>
      );
    }
  });

  return crumbs;
}
