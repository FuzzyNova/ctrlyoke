import {
  WORKSPACE_FILE_INDEX_STATES,
  type WorkspaceFileTreeEntryKind,
} from "../../types/DashboardConstants";
import type {
  WorkspaceFileIndexStatus,
  WorkspaceFileQueries,
} from "../../completions/WorkspaceFileIndex";
import {
  WorkspacePathQuery,
  type WorkspacePathQueryOptions,
  type WorkspacePathResult,
} from "../../completions/WorkspacePathQuery";
import { WorkspacePathStore } from "../../completions/WorkspacePathStore";

/** In-memory WorkspaceFileQueries test double with production query semantics. */
export class InMemoryWorkspaceFileQueries implements WorkspaceFileQueries {
  private readonly store = new WorkspacePathStore();
  private readonly query = new WorkspacePathQuery(this.store);

  constructor(paths: readonly string[] = []) {
    this.store.replaceAll(paths);
  }

  queryFiles(
    query: string,
    options?: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]> {
    return this.query.queryFiles(query, options);
  }

  queryPromptFiles(
    query: string,
    options?: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]> {
    return this.query.queryPromptFiles(query, options);
  }

  suggestPaths(
    typedPath: string,
    kind: WorkspaceFileTreeEntryKind,
    maxResults?: number,
    options?: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]> {
    return this.query.suggestPaths(typedPath, kind, maxResults, options);
  }

  getStatus(): WorkspaceFileIndexStatus {
    return {
      state: WORKSPACE_FILE_INDEX_STATES.READY,
      indexed: this.store.files.length,
    };
  }
}
