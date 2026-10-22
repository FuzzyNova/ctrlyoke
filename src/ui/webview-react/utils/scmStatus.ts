/**
 * Shared color mapping for git source-control status, matching VS Code's
 * gitDecoration palette (see the `--color-scm-*-fg` tokens in styles/globals.css).
 */
import type { SourceControlFile } from "@root/types/HostedWorkspaceViewerTypes";

/** Text color class for a file/directory ignored via .gitignore. */
export const SCM_IGNORED_COLOR_CLASS = "text-scm-ignored-fg";

/** Text color class keyed off a SourceControlFile's status kind. */
export const SCM_KIND_COLOR_CLASS: Record<SourceControlFile["kind"], string> = {
  added: "text-scm-added-fg",
  deleted: "text-scm-deleted-fg",
  modified: "text-scm-modified-fg",
  renamed: "text-scm-renamed-fg",
  untracked: "text-scm-untracked-fg",
};

/** Text color classes for change kinds counted as posh-git's `+`, `~` and `-`. */
export const SCM_CHANGE_COUNT_COLOR_CLASS = {
  added: "text-scm-added-fg",
  modified: "text-scm-modified-fg",
  deleted: "text-scm-deleted-fg",
} as const;

/**
 * Mainline colors of the commit graph (the `--color-scm-graph-*` tokens),
 * themed from VS Code's scmGraph ref colors.
 */
export const SCM_GRAPH_TRUNK_COLOR_CLASS = {
  local: "text-scm-graph-local",
  remote: "text-scm-graph-remote",
} as const;

/** The commit graph's rotating branch palette (VS Code's scmGraph.foreground1-5). */
export const SCM_GRAPH_BRANCH_COLOR_CLASSES = [
  "text-scm-graph-fg1",
  "text-scm-graph-fg2",
  "text-scm-graph-fg3",
  "text-scm-graph-fg4",
  "text-scm-graph-fg5",
] as const;

/**
 * Branch palette color for a 1-based rotating color index, as assigned by
 * `computeCommitGraphLayout` (index 0 is the trunk and has no palette entry).
 */
export function scmGraphBranchColorClass(colorIndex: number): string {
  return SCM_GRAPH_BRANCH_COLOR_CLASSES[
    (colorIndex - 1) % SCM_GRAPH_BRANCH_COLOR_CLASSES.length
  ];
}
