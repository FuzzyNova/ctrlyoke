import { isMainThread, parentPort } from "worker_threads";
import { WORKSPACE_FILE_INDEX_LOG_LEVELS, WORKSPACE_FILE_INDEX_MESSAGE_TYPES, WorkspaceFileIndexPipeline, type WorkspaceFileChange, type WorkspaceFileIndexBuildOptions } from "./WorkspaceFileIndex";
import type { WorkspacePathQueryOptions } from "./WorkspacePathQuery";

const port = parentPort;
if (!isMainThread && port) {
  let index: WorkspaceFileIndexPipeline | undefined;
  const controllers = new Map<string, AbortController>();
  port.on("message", async (message: { id: number; type: string; [key: string]: unknown }) => {
    try {
      if (!index) index = new WorkspaceFileIndexPipeline([], false);
      let value: unknown;
      if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.BUILD) {
        const options = message.options as WorkspaceFileIndexBuildOptions | undefined;
        await index.build(options);
        port.postMessage({ type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.STATUS, status: index.getStatus() });
      } else if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.APPLY_CHANGES) {
        await index.applyChanges(message.changes as readonly WorkspaceFileChange[]);
        setTimeout(() => port.postMessage({ type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.STATUS, status: index?.getStatus() }), 225);
      } else if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES || message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES || message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS) {
        const queryId = message.queryId as string;
        const controller = new AbortController();
        controllers.set(queryId, controller);
        const options: WorkspacePathQueryOptions = {
          limit: message.limit as number | undefined,
          signal: controller.signal,
          onProgress: (progress) => port.postMessage({ type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.PROGRESS, queryId, progress }),
        };
        if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES) value = await index.queryFiles(message.query as string, options);
        else if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES) value = await index.queryPromptFiles(message.query as string, options);
        else value = await index.suggestPaths(message.query as string, message.kind as never, message.maxResults as number | undefined, options);
        controllers.delete(queryId);
      } else if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.CANCEL) {
        controllers.get(message.queryId as string)?.abort();
        return;
      } else if (message.type === WORKSPACE_FILE_INDEX_MESSAGE_TYPES.DISPOSE) {
        for (const controller of controllers.values()) controller.abort();
        controllers.clear();
        index.dispose();
        port.close();
        return;
      }
      port.postMessage({ id: message.id, type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.RESULT, value, status: index.getStatus() });
    } catch (error) {
      port.postMessage({ type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.LOG, level: WORKSPACE_FILE_INDEX_LOG_LEVELS.WARN, message: `Workspace file index operation failed: ${error instanceof Error ? error.message : String(error)}` });
      port.postMessage({ id: message.id, type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.ERROR, message: error instanceof Error ? error.message : String(error) });
    }
  });
}
