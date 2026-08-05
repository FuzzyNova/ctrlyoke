import type { DiffType } from "react-diff-view";
import type { DiffKind } from "@root/types/HostedWorkspaceViewerTypes";
import {
  DIFF_CHANGE_TYPES,
  type DiffChangeType,
} from "@root/types/DashboardConstants";
import type { PromptChangeType } from "@root/types/OutputHistoryTypes";

const RDV_DIFF_TYPES = {
  ADD: "add",
  DELETE: "delete",
  MODIFY: "modify",
  RENAME: "rename",
  COPY: "copy",
} as const;

export const DIFF_CHANGE_LABEL: Record<DiffChangeType, string> = {
  [DIFF_CHANGE_TYPES.CREATED]: "created",
  [DIFF_CHANGE_TYPES.MODIFIED]: "modified",
  [DIFF_CHANGE_TYPES.DELETED]: "deleted",
  [DIFF_CHANGE_TYPES.RENAMED]: "renamed",
};

export const DIFF_CHANGE_COLOR: Record<DiffChangeType, string> = {
  [DIFF_CHANGE_TYPES.CREATED]: "text-diff-added-fg",
  [DIFF_CHANGE_TYPES.MODIFIED]: "text-warning-fg",
  [DIFF_CHANGE_TYPES.DELETED]: "text-indicator-error",
  [DIFF_CHANGE_TYPES.RENAMED]: "text-description-fg",
};

export const DIFF_CHANGE_ICON: Record<DiffChangeType, string> = {
  [DIFF_CHANGE_TYPES.CREATED]: "codicon-diff-added",
  [DIFF_CHANGE_TYPES.MODIFIED]: "codicon-diff-modified",
  [DIFF_CHANGE_TYPES.DELETED]: "codicon-diff-removed",
  [DIFF_CHANGE_TYPES.RENAMED]: "codicon-diff-renamed",
};

const PROMPT_CHANGE_TYPE_MAP: Record<PromptChangeType, DiffChangeType> = {
  created: DIFF_CHANGE_TYPES.CREATED,
  modified: DIFF_CHANGE_TYPES.MODIFIED,
  deleted: DIFF_CHANGE_TYPES.DELETED,
};

const DIFF_KIND_MAP: Record<DiffKind, DiffChangeType> = {
  modified: DIFF_CHANGE_TYPES.MODIFIED,
  added: DIFF_CHANGE_TYPES.CREATED,
  deleted: DIFF_CHANGE_TYPES.DELETED,
  renamed: DIFF_CHANGE_TYPES.RENAMED,
  untracked: DIFF_CHANGE_TYPES.CREATED,
};

const RDV_DIFF_TYPE_MAP: Record<DiffType, DiffChangeType> = {
  [RDV_DIFF_TYPES.ADD]: DIFF_CHANGE_TYPES.CREATED,
  [RDV_DIFF_TYPES.DELETE]: DIFF_CHANGE_TYPES.DELETED,
  [RDV_DIFF_TYPES.MODIFY]: DIFF_CHANGE_TYPES.MODIFIED,
  [RDV_DIFF_TYPES.RENAME]: DIFF_CHANGE_TYPES.RENAMED,
  [RDV_DIFF_TYPES.COPY]: DIFF_CHANGE_TYPES.RENAMED,
};

export function fromPromptChangeType(
  changeType: PromptChangeType
): DiffChangeType {
  return PROMPT_CHANGE_TYPE_MAP[changeType];
}

export function fromDiffKind(changeKind: DiffKind): DiffChangeType {
  return DIFF_KIND_MAP[changeKind];
}

export function fromRdvDiffType(diffType: DiffType): DiffChangeType {
  return RDV_DIFF_TYPE_MAP[diffType];
}
