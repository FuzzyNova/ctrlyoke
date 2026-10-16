import { isMainThread, parentPort } from "worker_threads";
import {
  runPipelineQuery,
  WORKSPACE_FILE_INDEX_LOG_LEVELS,
  WORKSPACE_FILE_INDEX_MESSAGE_TYPES,
  WorkspaceFileIndexPipeline,
  type WorkspaceFileIndexRequest,
  type WorkspaceFileIndexResponse,
} from "./WorkspaceFileIndex";

const port = parentPort;
if (!isMainThread && port) {
  const post = (message: WorkspaceFileIndexResponse): void =>
    port.postMessage(message);
  // Roots and the gitignore mode arrive with the first build message.
  const index = new WorkspaceFileIndexPipeline([], false, undefined, {
    onStatus: (status) =>
      post({ type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.STATUS, status }),
  });
  const controllers = new Map<string, AbortController>();
  port.on("message", async (message: WorkspaceFileIndexRequest) => {
    try {
      let value: unknown;
      switch (message.type) {
        case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.BUILD:
          await index.build(message.options);
          break;
        case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.APPLY_CHANGES:
          await index.applyChanges(message.changes);
          break;
        case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_FILES:
        case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.QUERY_PROMPT_FILES:
        case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.SUGGEST_PATHS: {
          const { queryId } = message;
          const controller = new AbortController();
          controllers.set(queryId, controller);
          try {
            value = await runPipelineQuery(index, message, {
              signal: controller.signal,
              onProgress: (progress) =>
                post({
                  type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.PROGRESS,
                  queryId,
                  progress: { ...progress, results: [...progress.results] },
                }),
            });
          } finally {
            controllers.delete(queryId);
          }
          break;
        }
        case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.CANCEL:
          controllers.get(message.queryId)?.abort();
          return;
        case WORKSPACE_FILE_INDEX_MESSAGE_TYPES.DISPOSE:
          for (const controller of controllers.values()) controller.abort();
          controllers.clear();
          index.dispose();
          port.close();
          return;
      }
      post({
        id: message.id,
        type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.RESULT,
        value,
        status: index.getStatus(),
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      post({
        type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.LOG,
        level: WORKSPACE_FILE_INDEX_LOG_LEVELS.WARN,
        message: `Workspace file index operation failed: ${text}`,
      });
      post({
        id: message.id,
        type: WORKSPACE_FILE_INDEX_MESSAGE_TYPES.ERROR,
        message: text,
      });
    }
  });
}
