import * as fs from "fs";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";
import { MAX_INDEXED_TEXT_LENGTH } from "./historySearchRebuildWorker";
import type {
  HistorySearchDocument,
  WorkflowRunManifest,
} from "../../types/WorkflowTimelineTypes";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { Log } from "../../utils/Log";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { HistoryRunDocumentBuilder } from "./HistoryRunDocumentBuilder";
import { TimelineRecorder } from "./TimelineRecorder";

const DEEP_CONTEXT_LEFT = 400;
const DEEP_CONTEXT_RIGHT = 400;
const MAX_DEEP_DOCUMENT_TEXT_LENGTH = MAX_INDEXED_TEXT_LENGTH - 1;

export type HistoryWorkflowNameResolver = (
  workflowKey: WorkflowKey
) => Promise<string>;

/**
 * Streams the matches hidden by the capped history-search index for one run.
 * The source is deliberately read-only and the yielded document text is kept
 * below the indexed text cap even though the source candidate is uncapped.
 */
export async function* scanHistoryRunDeep(
  workspaceFolderPath: string,
  manifestPath: string,
  normalizedQuery: string,
  resolveWorkflowName: HistoryWorkflowNameResolver,
  signal?: AbortSignal
): AsyncGenerator<HistorySearchDocument, void, undefined> {
  const address = WorkflowPaths.parseRunArtifactPath(
    workspaceFolderPath,
    manifestPath
  );
  if (!address || address.fileName !== TimelineRecorder.MANIFEST_FILE_NAME) {
    Log.warn(
      `[HistoryRunDeepScanner] Invalid run manifest path: ${manifestPath}`
    );
    return;
  }

  if (signal?.aborted) {
    return;
  }

  const timelineRecorder = new TimelineRecorder();
  let manifest: WorkflowRunManifest;
  try {
    manifest = await timelineRecorder.readManifest(manifestPath);
  } catch (error) {
    Log.warn(
      `[HistoryRunDeepScanner] Failed to read manifest ${manifestPath}: ${getErrorMessage(error)}`
    );
    return;
  }

  const eventsPath = WorkflowPaths.eventsPath(
    workspaceFolderPath,
    address.workflowKey,
    address.runRef
  );
  try {
    await fs.promises.access(eventsPath, fs.constants.R_OK);
  } catch (error) {
    Log.warn(
      `[HistoryRunDeepScanner] Failed to read events ${eventsPath}: ${getErrorMessage(error)}`
    );
    return;
  }

  let workflowName: string;
  try {
    workflowName = await resolveWorkflowName(address.workflowKey);
  } catch (error) {
    Log.warn(
      `[HistoryRunDeepScanner] Failed to resolve workflow name for ${address.workflowKey}: ${getErrorMessage(error)}`
    );
    return;
  }

  const queryLower = normalizedQuery.toLowerCase();
  const documentBuilder = new HistoryRunDocumentBuilder();
  const context = {
    manifest,
    workflowKey: address.workflowKey,
    runRef: address.runRef,
    workflowName,
  };

  try {
    for await (const event of timelineRecorder.streamEvents(manifestPath)) {
      if (signal?.aborted) {
        return;
      }

      const documents = documentBuilder.buildEventDocuments(event, context, {
        projectCandidate: (candidate) => {
          const textLower = candidate.text.toLowerCase();
          if (
            textLower.slice(0, MAX_INDEXED_TEXT_LENGTH).includes(queryLower)
          ) {
            return undefined;
          }

          const matchIndex = textLower.indexOf(queryLower);
          if (matchIndex < 0) {
            return undefined;
          }

          return createBoundedTextProjection(
            candidate.text,
            matchIndex,
            normalizedQuery.length
          );
        },
      });

      for (const document of documents) {
        if (signal?.aborted) {
          return;
        }
        yield document;
      }
    }
  } catch (error) {
    Log.warn(
      `[HistoryRunDeepScanner] Failed to read events ${eventsPath}: ${getErrorMessage(error)}`
    );
  }
}

function createBoundedTextProjection(
  text: string,
  matchIndex: number,
  queryLength: number
): { text: string; textLower: string } {
  const maxLength = MAX_DEEP_DOCUMENT_TEXT_LENGTH;
  const matchEnd = Math.min(text.length, matchIndex + queryLength);
  let start = Math.max(0, matchIndex - DEEP_CONTEXT_LEFT);
  let end = Math.min(text.length, matchEnd + DEEP_CONTEXT_RIGHT);

  if (end - start > maxLength) {
    const matchLength = Math.min(queryLength, maxLength);
    const contextBudget = maxLength - matchLength;
    const left = Math.min(DEEP_CONTEXT_LEFT, Math.floor(contextBudget / 2));
    const right = Math.min(DEEP_CONTEXT_RIGHT, contextBudget - left);
    start = Math.max(0, matchIndex - left);
    end = Math.min(text.length, matchIndex + matchLength + right);
  }

  const boundedText = text.slice(start, end);
  return {
    text: boundedText,
    textLower: boundedText.toLowerCase(),
  };
}
