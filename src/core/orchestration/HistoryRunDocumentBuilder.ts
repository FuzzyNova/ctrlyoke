import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import type { OutputExecutionTarget } from "../../types/OutputHistoryTypes";
import {
  TIMELINE_EVENT_TYPES,
  type HistorySearchDocument,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import {
  HistoryCandidateExtractor,
  type MatchCandidate,
} from "./HistoryCandidateExtractor";

export interface HistoryRunDocumentBuilderContext {
  manifest: WorkflowRunManifest;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  workflowName: string;
}

export interface HistoryRunDocumentTextProjection {
  text: string;
  textLower: string;
}

export interface HistoryRunDocumentBuildOptions {
  projectCandidate?: (
    candidate: MatchCandidate
  ) => HistoryRunDocumentTextProjection | undefined;
}

export class HistoryRunDocumentBuilder {
  private readonly candidateExtractor: HistoryCandidateExtractor;

  constructor(maxTextLength?: number) {
    this.candidateExtractor = new HistoryCandidateExtractor({
      maxTextLength,
    });
  }

  async buildRunDocuments(
    events: AsyncIterable<WorkflowTimelineEvent>,
    context: HistoryRunDocumentBuilderContext
  ): Promise<HistorySearchDocument[]> {
    const documents: HistorySearchDocument[] = [];
    try {
      for await (const event of events) {
        documents.push(...this.buildEventDocuments(event, context));
      }
    } catch {
      // Do not publish a partial shard after a read/parse failure.
      return [];
    }
    return documents;
  }

  buildEventDocuments(
    event: WorkflowTimelineEvent,
    context: HistoryRunDocumentBuilderContext,
    options: HistoryRunDocumentBuildOptions = {}
  ): HistorySearchDocument[] {
    const target = "target" in event ? event.target : undefined;
    if (!target) {
      return [];
    }

    const candidates = this.collectEventCandidates(event);
    const outputMetadata =
      event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED
        ? event.payload.cliOutput.structured?.metadata
        : undefined;

    return candidates.flatMap((candidate, candidateIndex) => {
      const textProjection = options.projectCandidate
        ? options.projectCandidate(candidate)
        : {
            text: candidate.text,
            textLower: candidate.text.toLowerCase(),
          };
      if (!textProjection) {
        return [];
      }
      return [
        this.buildDocument(
          context,
          target,
          this.getAttemptIndex(event),
          event.sequence,
          event.timestampMs,
          candidate,
          candidateIndex,
          textProjection,
          outputMetadata
        ),
      ];
    });
  }

  private collectEventCandidates(
    event: WorkflowTimelineEvent
  ): MatchCandidate[] {
    switch (event.eventType) {
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED:
        return this.candidateExtractor.collectCliOutputCandidates(
          event.payload.cliOutput
        );
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED:
        return this.candidateExtractor.collectStructuredEventsCandidates(
          event.payload.events
        );
      case TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED:
        return this.candidateExtractor.collectScriptExecutionCandidates(
          event.payload,
          event.phase
        );
      case TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED:
        return this.candidateExtractor.collectStatusCandidates(
          event.payload.statusMessage.message
        );
      default:
        return [];
    }
  }

  private getAttemptIndex(event: WorkflowTimelineEvent): number {
    switch (event.eventType) {
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED:
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED:
      case TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED:
        return event.attemptIndex;
      default:
        return 0;
    }
  }

  private buildDocument(
    context: HistoryRunDocumentBuilderContext,
    target: OutputExecutionTarget,
    attemptIndex: number,
    sequence: number,
    timestampMs: number,
    candidate: MatchCandidate,
    candidateIndex: number,
    textProjection: HistoryRunDocumentTextProjection,
    outputMetadata?: {
      harness?: string;
      model?: string;
      sessionId?: string;
    }
  ): HistorySearchDocument {
    const { manifest, workflowKey, runRef, workflowName } = context;
    return {
      id: [
        workflowKey,
        runRef,
        manifest.runId,
        sequence,
        `${candidate.eventKind}:${candidate.matchField}`,
        candidateIndex,
      ].join(":"),
      workflowKey,
      runRef,
      workflowName,
      runId: manifest.runId,
      startedAt: manifest.startedAt,
      executionState: manifest.executionState,
      target,
      attemptIndex,
      sequence,
      timestampMs,
      eventKind: candidate.eventKind,
      matchField: candidate.matchField,
      text: textProjection.text,
      textLower: textProjection.textLower,
      filePath: candidate.filePath,
      harness: outputMetadata?.harness,
      model: outputMetadata?.model,
      sessionId: outputMetadata?.sessionId,
    };
  }
}
