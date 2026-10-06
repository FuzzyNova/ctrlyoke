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
