import type {
  WorkspaceTreePageRequest,
  WorkspaceTreeRangeRequest,
} from "../types/HostedWorkspaceViewerTypes";
import { WorkspaceTreeBadRequestError } from "./WorkspaceTreeErrors";

export type WorkspaceTreeRequest =
  | WorkspaceTreePageRequest
  | WorkspaceTreeRangeRequest;

const LISTING_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parse the endpoint's mutually exclusive initial and range query shapes. */
export function parseWorkspaceTreeQuery(
  query: Record<string, unknown>
): WorkspaceTreeRequest {
  const listingId = readOptionalString(query, "listingId");
  const hasRangeFields = listingId !== undefined || query.offset !== undefined;
  const hasInitialFields =
    query.path !== undefined ||
    query.pageSize !== undefined ||
    query.includeGitIgnored !== undefined ||
    query.anchorPath !== undefined;

  if (hasRangeFields) {
    if (!listingId || !LISTING_ID_PATTERN.test(listingId)) {
      throw new WorkspaceTreeBadRequestError("listingId is invalid");
    }
    if (hasInitialFields) {
      throw new WorkspaceTreeBadRequestError(
        "Initial and range tree parameters are mutually exclusive"
      );
    }
    return {
      listingId,
      offset: readInteger(query, "offset", "offset is required"),
    };
  }

  const path = readOptionalString(query, "path") ?? "";
  const anchorPath = readOptionalString(query, "anchorPath");
  const pageSizeValue = readOptionalString(query, "pageSize");
  const pageSize =
    pageSizeValue === undefined
      ? undefined
      : readPositiveInteger(pageSizeValue, "pageSize");
  const includeGitIgnoredValue = readOptionalString(query, "includeGitIgnored");
  const includeGitIgnored =
    includeGitIgnoredValue === undefined
      ? false
      : parseBoolean(includeGitIgnoredValue, "includeGitIgnored");

  return {
    path,
    ...(pageSize === undefined ? {} : { pageSize }),
    includeGitIgnored,
    ...(anchorPath === undefined ? {} : { anchorPath }),
  };
}

function readOptionalString(
  query: Record<string, unknown>,
  key: string
): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || (value.length === 0 && key !== "path")) {
    throw new WorkspaceTreeBadRequestError(`${key} is invalid`);
  }
  return value;
}

function readInteger(
  query: Record<string, unknown>,
  key: string,
  missingMessage: string
): number {
  const value = readOptionalString(query, key);
  if (value === undefined) {
    throw new WorkspaceTreeBadRequestError(missingMessage);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WorkspaceTreeBadRequestError(
      `${key} must be a non-negative integer`
    );
  }
  return parsed;
}

function readPositiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new WorkspaceTreeBadRequestError(`${key} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string, key: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new WorkspaceTreeBadRequestError(`${key} must be true or false`);
}
