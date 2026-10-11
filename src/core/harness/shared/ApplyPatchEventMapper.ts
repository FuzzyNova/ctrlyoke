import type { ApplyPatchFileEdit } from "./ApplyPatchParser";
import type {
  CliEvent,
  FileDeleteData,
  FileEditData,
  FileWriteData,
} from "../../../types/CliOutputTypes";
import {
  APPLY_PATCH_FILE_EDIT_KINDS,
  CLI_EVENT_TYPES,
} from "../../../types/DashboardConstants";
import type { FileOperationStatus } from "../../../types/DashboardConstants";

/** Build the semantic file event for one parsed apply_patch file section. */
export function buildApplyPatchFileEvent(
  fileEdit: ApplyPatchFileEdit,
  timestamp: number,
  status: FileOperationStatus,
  extraData: Record<string, unknown> = {}
): CliEvent {
  if (fileEdit.kind === APPLY_PATCH_FILE_EDIT_KINDS.ADD) {
    return {
      type: CLI_EVENT_TYPES.FILE_WRITE,
      timestamp,
      data: {
        path: fileEdit.path,
        content: "",
        structuredPatch: fileEdit.structuredPatch,
        status,
        ...extraData,
      } as FileWriteData,
    };
  }

  if (fileEdit.kind === APPLY_PATCH_FILE_EDIT_KINDS.DELETE) {
    return {
      type: CLI_EVENT_TYPES.FILE_DELETE,
      timestamp,
      data: {
        path: fileEdit.path,
        structuredPatch: fileEdit.structuredPatch,
        status,
        ...extraData,
      } as FileDeleteData,
    };
  }

  return {
    type: CLI_EVENT_TYPES.FILE_EDIT,
    timestamp,
    data: {
      path: fileEdit.path,
      structuredPatch: fileEdit.structuredPatch,
      status,
      ...extraData,
    } as FileEditData,
  };
}

/** Fallback event when a patch cannot be split into per-file sections. */
export function buildApplyPatchFallbackEvent(
  path: string,
  structuredPatch: FileEditData["structuredPatch"],
  timestamp: number,
  status: FileOperationStatus,
  extraData: Record<string, unknown> = {}
): CliEvent {
  return {
    type: CLI_EVENT_TYPES.FILE_EDIT,
    timestamp,
    data: { path, structuredPatch, status, ...extraData } as FileEditData,
  };
}
