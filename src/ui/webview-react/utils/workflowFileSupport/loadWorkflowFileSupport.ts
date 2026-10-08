export type WorkflowFileSupport = typeof import("./workflowFileSupport");

let loading: Promise<WorkflowFileSupport> | null = null;

/** Fetches the location/completion chunk once; every caller shares the promise. */
export function loadWorkflowFileSupport(): Promise<WorkflowFileSupport> {
  loading ??= import("./workflowFileSupport").catch((error: unknown) => {
    // Let the next editor retry instead of caching a failed chunk fetch.
    loading = null;
    throw error;
  });
  return loading;
}
