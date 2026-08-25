import React, { useCallback, useEffect, useState } from "react";
import { DiffView } from "@components/output/DiffView";
import type { HunkData, DiffType } from "react-diff-view";
import type { UnifiedDiffHunk } from "@root/types/CliOutputTypes";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";
import {
  DIFF_CHANGE_COLOR,
  DIFF_CHANGE_ICON,
  DIFF_CHANGE_LABEL,
} from "./diffChangeType";
import {
  DiffFileDirectoryLabel,
  DiffFileNameLabel,
  diffFilePathTitle,
} from "./DiffFilePathLabel";
import type { DiffChangeType } from "@root/types/DashboardConstants";
import type {
  WorkspaceFileHistoryDiffResponse,
  WorkspaceImageDiffSides,
} from "@root/types/HostedWorkspaceViewerTypes";
import { DIFF_PAYLOAD_KINDS } from "@root/types/DashboardConstants";
import { ImageDiffView } from "./ImageDiffView";
import { workspaceFileHistoryDiff } from "@utils/hostedApi";

export type DeferredDiffState =
  (typeof DEFERRED_DIFF_STATES)[keyof typeof DEFERRED_DIFF_STATES];

export type DeferredDiffDetailFetcher = (
  path: string,
  commit: string,
  repo?: string
) => Promise<WorkspaceFileHistoryDiffResponse>;

export interface DeferredDiffFileSource {
  kind: "deferred";
  commit: string;
  repo?: string;
  state: DeferredDiffState;
  detail?: WorkspaceFileHistoryDiffResponse;
  error?: Error;
  fetchDetail?: DeferredDiffDetailFetcher;
}

export const DEFERRED_DIFF_STATES = {
  NOT_LOADED: "not-loaded",
  LOADING: "loading",
  LOADED: "loaded",
  ERROR: "error",
} as const;

const fileHistoryDetailCache = new Map<
  string,
  WorkspaceFileHistoryDiffResponse
>();
const fileHistoryDetailRequests = new Map<
  string,
  Promise<WorkspaceFileHistoryDiffResponse>
>();

function fetchCachedFileHistoryDetail(
  path: string,
  commit: string,
  repo: string | undefined
): Promise<WorkspaceFileHistoryDiffResponse> {
  const key = `${repo ?? ""}\u0000${path}\u0000${commit}`;
  const cached = fileHistoryDetailCache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = fileHistoryDetailRequests.get(key);
  if (existing) return existing;

  const request = workspaceFileHistoryDiff(path, commit, repo).then(
    (response) => {
      fileHistoryDetailCache.set(key, response);
      fileHistoryDetailRequests.delete(key);
      return response;
    },
    (error: unknown) => {
      fileHistoryDetailRequests.delete(key);
      throw error;
    }
  );
  fileHistoryDetailRequests.set(key, request);
  return request;
}

function detailToSource(
  detail: WorkspaceFileHistoryDiffResponse
): Exclude<DiffFileCardProps["source"], DeferredDiffFileSource> {
  switch (detail.payloadKind) {
    case DIFF_PAYLOAD_KINDS.TEXT:
      return {
        kind: "content",
        oldContent: detail.oldContent,
        newContent: detail.newContent,
      };
    case DIFF_PAYLOAD_KINDS.IMAGE:
      return { kind: "image", image: detail.image };
    case DIFF_PAYLOAD_KINDS.BINARY:
      return { kind: "binary" };
  }
}

export interface DiffFileCardProps {
  path: string;
  /** Previous path — set only for a true rename. Never a /dev/null sentinel. */
  oldPath?: string;
  changeType: DiffChangeType;

  /** Exactly one diff source. */
  source:
    | { kind: "hunks"; hunks: HunkData[]; diffType: DiffType }
    | { kind: "content"; oldContent?: string; newContent?: string }
    | {
        kind: "patch";
        structuredPatch: UnifiedDiffHunk[];
        oldContent?: string;
      }
    | { kind: "image"; image: WorkspaceImageDiffSides }
    | { kind: "binary" }
    | DeferredDiffFileSource;

  language?: string;

  /** Present ⇒ the card renders a checkbox. Absent ⇒ read-only card. */
  selection?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabledReason?: string;
  };

  /** Small italic note on the header row. */
  note?: string;
  /** Right-aligned slot. */
  headerActions?: React.ReactNode;

  /** Controlled collapsed state, owned by the containing list. */
  collapsed?: boolean;
  /** Called when the user toggles this file's collapsed state. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Controlled hidden-gap expansion state, owned by the containing list. */
  expandedGaps?: DiffGapExpansionState;
  /** Called when the user expands a hidden context gap. */
  onExpandGap?: (gapIndex: number, nextExpandedToLine: number) => void;
  /** Optional list semantics supplied by DiffFileList for realized rows. */
  ariaSetSize?: number;
  ariaPosInSet?: number;
  findQuery?: string;
  findCaseSensitive?: boolean;
  viewType?: "split" | "unified";
}

export const DiffFileCard: React.FC<DiffFileCardProps> = ({
  path,
  oldPath,
  changeType,
  source,
  language,
  selection,
  note,
  headerActions,
  collapsed,
  onCollapsedChange,
  expandedGaps,
  onExpandGap,
  ariaSetSize,
  ariaPosInSet,
  findQuery,
  findCaseSensitive,
  viewType,
}) => {
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState(
    source.kind === "deferred"
  );
  const [deferredState, setDeferredState] =
    useState<DeferredDiffFileSource | null>(() =>
      source.kind === "deferred" ? source : null
    );

  useEffect(() => {
    if (source.kind !== "deferred") {
      setDeferredState(null);
      return;
    }
    setDeferredState((current) => {
      if (
        current === null ||
        current.commit !== source.commit ||
        current.repo !== source.repo
      ) {
        return source;
      }
      if (
        source.state === DEFERRED_DIFF_STATES.LOADED &&
        current.state !== DEFERRED_DIFF_STATES.LOADED
      ) {
        return source;
      }
      return current;
    });
  }, [source]);

  const isCollapsed = collapsed ?? uncontrolledCollapsed;
  const requestDeferredDetail = useCallback(
    (retry = false): void => {
      if (!deferredState) return;
      const isNotLoaded =
        deferredState.state === DEFERRED_DIFF_STATES.NOT_LOADED;
      if (!retry && !isNotLoaded) return;

      setDeferredState({
        ...deferredState,
        state: DEFERRED_DIFF_STATES.LOADING,
        error: undefined,
      });
      const request = deferredState.fetchDetail
        ? deferredState.fetchDetail(
            path,
            deferredState.commit,
            deferredState.repo
          )
        : fetchCachedFileHistoryDetail(
            path,
            deferredState.commit,
            deferredState.repo
          );
      void request.then(
        (detail) => {
          setDeferredState((current) =>
            current && current.commit === deferredState.commit
              ? {
                  ...current,
                  state: DEFERRED_DIFF_STATES.LOADED,
                  detail,
                  error: undefined,
                }
              : current
          );
        },
        (value: unknown) => {
          const error =
            value instanceof Error ? value : new Error(String(value));
          setDeferredState((current) =>
            current && current.commit === deferredState.commit
              ? { ...current, state: DEFERRED_DIFF_STATES.ERROR, error }
              : current
          );
        }
      );
    },
    [deferredState, path]
  );

  const handleCollapsedChange = useCallback(
    (nextCollapsed: boolean): void => {
      onCollapsedChange?.(nextCollapsed);
      if (collapsed === undefined) setUncontrolledCollapsed(nextCollapsed);
      if (
        !nextCollapsed &&
        deferredState &&
        deferredState.state === DEFERRED_DIFF_STATES.NOT_LOADED
      ) {
        requestDeferredDetail();
      }
    },
    [collapsed, deferredState, onCollapsedChange, requestDeferredDetail]
  );

  const renderedSource =
    deferredState?.state === DEFERRED_DIFF_STATES.LOADED && deferredState.detail
      ? detailToSource(deferredState.detail)
      : source;
  const resolvedDetail =
    deferredState?.state === DEFERRED_DIFF_STATES.LOADED
      ? deferredState.detail
      : undefined;
  const renderedPath = resolvedDetail?.path ?? path;
  const renderedOldPath = resolvedDetail?.oldPath ?? oldPath;
  const renderedChangeType = resolvedDetail?.changeType ?? changeType;
  const renderedLanguage = resolvedDetail?.language ?? language;
  const cardCollapsed = source.kind === "deferred" ? isCollapsed : collapsed;
  const cardCollapseHandler =
    source.kind === "deferred" ? handleCollapsedChange : onCollapsedChange;

  const sharedDiffViewProps = {
    language: renderedLanguage,
    globallyCollapsed: cardCollapsed ?? false,
    collapsed: cardCollapsed,
    onCollapsedChange: cardCollapseHandler,
    expandedGaps,
    onExpandGap,
    findQuery,
    findCaseSensitive,
    viewType,
    outerMarginClassName: "my-1",
  };
  const diffView = (() => {
    if (
      isCollapsed &&
      deferredState &&
      deferredState.state !== DEFERRED_DIFF_STATES.LOADED
    ) {
      return null;
    }
    if (deferredState?.state === DEFERRED_DIFF_STATES.LOADING) {
      return (
        <div
          className="my-1 border-t border-panel-border px-2.5 py-2 text-xs text-description-fg"
          aria-live="polite"
        >
          Loading history diff…
        </div>
      );
    }
    if (deferredState?.state === DEFERRED_DIFF_STATES.ERROR) {
      return (
        <div
          className="my-1 border-t border-panel-border px-2.5 py-2 text-xs text-description-fg"
          role="alert"
        >
          <span>Unable to load history diff.</span>
          <button
            type="button"
            className="ml-2 underline hover:text-foreground"
            onClick={() => requestDeferredDetail(true)}
          >
            Retry
          </button>
        </div>
      );
    }
    switch (renderedSource.kind) {
      case "hunks":
        return (
          <DiffView
            hunks={renderedSource.hunks}
            diffType={renderedSource.diffType}
            {...sharedDiffViewProps}
          />
        );
      case "content":
        return (
          <DiffView
            oldContent={renderedSource.oldContent}
            newContent={renderedSource.newContent}
            {...sharedDiffViewProps}
          />
        );
      case "patch":
        return (
          <DiffView
            structuredPatch={renderedSource.structuredPatch}
            oldContent={renderedSource.oldContent}
            {...sharedDiffViewProps}
          />
        );
      case "image":
        return (
          <ImageDiffView
            path={renderedPath}
            sides={renderedSource.image}
            collapsed={cardCollapsed}
            onCollapsedChange={cardCollapseHandler}
          />
        );
      case "binary":
        return (
          <div className="my-1 border-t border-panel-border px-2.5 py-2 text-xs text-description-fg">
            <button
              type="button"
              className="flex items-center gap-1.5"
              aria-expanded={!isCollapsed}
              onClick={() => cardCollapseHandler?.(!isCollapsed)}
            >
              <i
                className={`codicon codicon-chevron-right text-xxs transition-transform ${isCollapsed ? "" : "rotate-90"}`}
              />
              <span>
                {isCollapsed ? "Show binary diff" : "Hide binary diff"}
              </span>
            </button>
            {!(source.kind === "deferred"
              ? isCollapsed
              : (collapsed ?? false)) && (
              <p className="mt-1 pl-4 italic">
                binary diff preview unavailable
              </p>
            )}
          </div>
        );
      case "deferred":
        return null;
    }
  })();

  const pathTitle = diffFilePathTitle(renderedPath, renderedOldPath);

  // `article`, not `listitem`: the card is a self-contained region with no
  // `role="list"` ancestor — the virtual spacer and absolutely positioned row
  // wrappers sit in between, and the list also holds heading/summary rows that a
  // list may not directly contain. An orphaned `listitem` is invalid ARIA and its
  // set metadata is not reliably exposed, while `article` supports
  // aria-posinset/aria-setsize standalone.
  return (
    <div
      className="border border-panel-border rounded overflow-hidden"
      {...(ariaSetSize !== undefined ? { role: "article" } : {})}
      aria-setsize={ariaSetSize}
      aria-posinset={ariaPosInSet}
    >
      <div className="sticky top-0 z-10 flex flex-col gap-0.5 border-b border-panel-border bg-editor-bg px-2.5 py-1 text-xs font-mono">
        <div className="flex items-center gap-2">
          {selection &&
            (selection.disabledReason ? (
              <span
                className="shrink-0 text-description-fg italic"
                title={selection.disabledReason}
              >
                {selection.disabledReason}
              </span>
            ) : (
              <input
                type="checkbox"
                checked={selection.checked}
                onChange={(event) => selection.onChange(event.target.checked)}
                aria-label={`Select ${path}`}
                className="shrink-0"
              />
            ))}
          <i
            className={`codicon ${DIFF_CHANGE_ICON[renderedChangeType]} shrink-0 ${DIFF_CHANGE_COLOR[renderedChangeType]}`}
            title={DIFF_CHANGE_LABEL[renderedChangeType]}
            aria-label={DIFF_CHANGE_LABEL[renderedChangeType]}
          />
          {deferredState &&
            deferredState.state !== DEFERRED_DIFF_STATES.LOADED && (
              <button
                type="button"
                className="flex shrink-0 items-center text-description-fg hover:text-foreground"
                aria-label={
                  isCollapsed ? "Expand history diff" : "Collapse history diff"
                }
                aria-expanded={!isCollapsed}
                onClick={() => handleCollapsedChange(!isCollapsed)}
              >
                <i
                  className={`codicon codicon-chevron-right text-xxs transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                />
              </button>
            )}
          <div
            className="flex min-w-0 flex-1 flex-col"
            title={pathTitle}
            aria-label={pathTitle}
          >
            <DiffFileNameLabel path={renderedPath} oldPath={renderedOldPath} />
            <DiffFileDirectoryLabel
              path={renderedPath}
              oldPath={renderedOldPath}
            />
          </div>
          {headerActions && (
            <div className="ml-auto flex shrink-0 items-center">
              {headerActions}
            </div>
          )}
        </div>
        {note && (
          <span className="pl-5 text-description-fg italic [overflow-wrap:anywhere]">
            {note}
          </span>
        )}
      </div>
      {diffView}
    </div>
  );
};
