import {
  CLI_EVENT_TYPES,
  HISTORY_EVENT_KINDS,
  HISTORY_MATCH_FIELDS,
  SCRIPT_OUTPUT_SOURCES,
  type ScriptOutputSource,
} from "../../types/DashboardConstants";
import type { CliOutput, CliEvent } from "../../types/WebviewMessageTypes";
import type {
  HistoryEventKind,
  HistoryMatchField,
} from "../../types/WorkflowTimelineTypes";

export interface MatchCandidate {
  eventKind: HistoryEventKind;
  matchField: HistoryMatchField;
  text: string;
  filePath?: string;
}

export interface HistoryCandidateExtractorOptions {
  maxTextLength?: number;
}

/**
 * The history event kind of a script's output, by its source. Search indexes
 * script output under these kinds and `history show --kind` filters by them,
 * so both surfaces must read this one map.
 */
export const SCRIPT_EVENT_KIND_BY_SOURCE: Readonly<
  Record<ScriptOutputSource, HistoryEventKind>
> = {
  [SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP]: HISTORY_EVENT_KINDS.SCRIPT,
  [SCRIPT_OUTPUT_SOURCES.PRE_CONDITION]: HISTORY_EVENT_KINDS.PRE_CONDITION,
  [SCRIPT_OUTPUT_SOURCES.END_CONDITION]: HISTORY_EVENT_KINDS.END_CONDITION,
  [SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP]: HISTORY_EVENT_KINDS.SCRIPT,
};

const HISTORY_EVENT_KIND_BY_CLI_EVENT_TYPE: Readonly<
  Partial<Record<string, HistoryEventKind>>
> = {
  [CLI_EVENT_TYPES.TEXT]: HISTORY_EVENT_KINDS.RESPONSE,
  [CLI_EVENT_TYPES.THINKING]: HISTORY_EVENT_KINDS.THINKING,
  [CLI_EVENT_TYPES.BASH_COMMAND]: HISTORY_EVENT_KINDS.BASH,
  [CLI_EVENT_TYPES.FILE_READ]: HISTORY_EVENT_KINDS.FILE_READ,
  [CLI_EVENT_TYPES.FILE_WRITE]: HISTORY_EVENT_KINDS.FILE_WRITE,
  [CLI_EVENT_TYPES.FILE_EDIT]: HISTORY_EVENT_KINDS.FILE_EDIT,
  [CLI_EVENT_TYPES.FILE_DELETE]: HISTORY_EVENT_KINDS.FILE_DELETE,
  [CLI_EVENT_TYPES.MCP_TOOL_CALL]: HISTORY_EVENT_KINDS.MCP_TOOL,
  [CLI_EVENT_TYPES.TOOL_CALL]: HISTORY_EVENT_KINDS.TOOL,
  [CLI_EVENT_TYPES.TOOL_RESULT]: HISTORY_EVENT_KINDS.TOOL,
  [CLI_EVENT_TYPES.WEB_SEARCH]: HISTORY_EVENT_KINDS.WEB_SEARCH,
  [CLI_EVENT_TYPES.COMPACTION]: HISTORY_EVENT_KINDS.COMPACTION,
};

/**
 * The history event kind a structured CLI event is indexed under, or
 * undefined for event types search does not index.
 */
export function historyEventKindForCliEventType(
  type: string
): HistoryEventKind | undefined {
  return Object.prototype.hasOwnProperty.call(
    HISTORY_EVENT_KIND_BY_CLI_EVENT_TYPE,
    type
  )
    ? HISTORY_EVENT_KIND_BY_CLI_EVENT_TYPE[type]
    : undefined;
}

export class HistoryCandidateExtractor {
  constructor(
    private readonly options: HistoryCandidateExtractorOptions = {}
  ) {}

  collectCliOutputCandidates(cliOutput: CliOutput): MatchCandidate[] {
    const scriptEventKind = cliOutput.source
      ? SCRIPT_EVENT_KIND_BY_SOURCE[cliOutput.source]
      : undefined;
    const candidates: MatchCandidate[] = [
      ...this.toCandidate(
        scriptEventKind ?? HISTORY_EVENT_KINDS.PROMPT,
        HISTORY_MATCH_FIELDS.CONTENT,
        cliOutput.prompt
      ),
      ...this.toCandidate(
        scriptEventKind ?? HISTORY_EVENT_KINDS.RESPONSE,
        scriptEventKind
          ? HISTORY_MATCH_FIELDS.OUTPUT
          : HISTORY_MATCH_FIELDS.CONTENT,
        cliOutput.response
      ),
      ...this.toCandidate(
        scriptEventKind ?? HISTORY_EVENT_KINDS.CLI_COMMAND,
        HISTORY_MATCH_FIELDS.COMMAND,
        cliOutput.cliCommand
      ),
    ];

    candidates.push(
      ...this.collectStructuredEventsCandidates(cliOutput.structured?.events)
    );

    return candidates;
  }

  /**
   * Structured CLI events also arrive outside a `CliOutput` snapshot — see
   * `CliOutputEventsAppendedEvent`, whose streamed deltas are folded into the
   * rendered output the same way a completed `cliOutput.structured.events`
   * snapshot is (`OutputHistoryTimelineAdapter`'s `StreamingCliOutputAccumulator`).
   * Exposed separately so callers indexing that event type reuse the exact
   * same per-event candidate extraction instead of duplicating it.
   */
  collectStructuredEventsCandidates(
    events: CliEvent[] | undefined
  ): MatchCandidate[] {
    return (events ?? []).flatMap((event) =>
      this.collectStructuredEventCandidates(event)
    );
  }

  collectStatusCandidates(message: string): MatchCandidate[] {
    return this.toCandidate(
      HISTORY_EVENT_KINDS.STATUS,
      HISTORY_MATCH_FIELDS.CONTENT,
      message
    );
  }

  private collectStructuredEventCandidates(event: CliEvent): MatchCandidate[] {
    const candidates: MatchCandidate[] = [];
    switch (event.type) {
      case CLI_EVENT_TYPES.TEXT:
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.RESPONSE,
            HISTORY_MATCH_FIELDS.CONTENT,
            this.getStringValue((event.data as { text?: unknown }).text)
          )
        );
        break;
      case CLI_EVENT_TYPES.THINKING:
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.THINKING,
            HISTORY_MATCH_FIELDS.CONTENT,
            this.getStringValue((event.data as { text?: unknown }).text)
          )
        );
        break;
      case CLI_EVENT_TYPES.BASH_COMMAND: {
        const data = event.data as {
          command?: unknown;
          output?: unknown;
          error?: unknown;
        };
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.BASH,
            HISTORY_MATCH_FIELDS.COMMAND,
            this.getStringValue(data.command)
          )
        );
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.BASH,
            HISTORY_MATCH_FIELDS.OUTPUT,
            this.getStringValue(data.output)
          )
        );
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.BASH,
            HISTORY_MATCH_FIELDS.ERROR,
            this.getStringValue(data.error)
          )
        );
        break;
      }
      case CLI_EVENT_TYPES.FILE_READ:
      case CLI_EVENT_TYPES.FILE_WRITE:
      case CLI_EVENT_TYPES.FILE_EDIT:
      case CLI_EVENT_TYPES.FILE_DELETE: {
        const data = event.data as {
          path?: unknown;
          content?: unknown;
          structuredPatch?: unknown;
        };
        const filePath = this.getStringValue(data.path);
        const eventKind = historyEventKindForCliEventType(event.type)!;
        candidates.push(
          ...this.toCandidate(
            eventKind,
            HISTORY_MATCH_FIELDS.PATH,
            filePath,
            filePath
          )
        );
        if (event.type === CLI_EVENT_TYPES.FILE_WRITE) {
          candidates.push(
            ...this.toCandidate(
              eventKind,
              HISTORY_MATCH_FIELDS.CONTENT,
              this.getStringValue(data.content),
              filePath
            )
          );
        }
        if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
          candidates.push(
            ...this.toCandidate(
              eventKind,
              HISTORY_MATCH_FIELDS.DIFF,
              this.flattenStructuredPatch(data.structuredPatch),
              filePath
            )
          );
        }
        break;
      }
      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const data = event.data as {
          server?: unknown;
          tool?: unknown;
          parameters?: unknown;
        };
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.MCP_TOOL,
            HISTORY_MATCH_FIELDS.CONTENT,
            this.getStringValue(data.server)
          )
        );
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.MCP_TOOL,
            HISTORY_MATCH_FIELDS.CONTENT,
            this.getStringValue(data.tool)
          )
        );
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.MCP_TOOL,
            HISTORY_MATCH_FIELDS.CONTENT,
            this.stringifyValue(data.parameters)
          )
        );
        break;
      }
      case CLI_EVENT_TYPES.TOOL_CALL: {
        const data = event.data as { name?: unknown; parameters?: unknown };
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.TOOL,
            HISTORY_MATCH_FIELDS.CONTENT,
            this.getStringValue(data.name)
          )
        );
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.TOOL,
            HISTORY_MATCH_FIELDS.CONTENT,
            this.stringifyValue(data.parameters)
          )
        );
        break;
      }
      case CLI_EVENT_TYPES.TOOL_RESULT: {
        const result = (
          event.data as {
            result?: { output?: unknown; error?: unknown };
          }
        ).result;
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.TOOL,
            HISTORY_MATCH_FIELDS.OUTPUT,
            this.getStringValue(result?.output)
          )
        );
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.TOOL,
            HISTORY_MATCH_FIELDS.ERROR,
            this.getStringValue(result?.error)
          )
        );
        break;
      }
      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as {
          query?: unknown;
          results?: Array<{ title?: string; snippet?: string; url?: string }>;
        };
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.WEB_SEARCH,
            HISTORY_MATCH_FIELDS.COMMAND,
            this.getStringValue(data.query)
          )
        );
        for (const result of data.results ?? []) {
          candidates.push(
            ...this.toCandidate(
              HISTORY_EVENT_KINDS.WEB_SEARCH,
              HISTORY_MATCH_FIELDS.CONTENT,
              result.title
            )
          );
          candidates.push(
            ...this.toCandidate(
              HISTORY_EVENT_KINDS.WEB_SEARCH,
              HISTORY_MATCH_FIELDS.CONTENT,
              result.snippet
            )
          );
          candidates.push(
            ...this.toCandidate(
              HISTORY_EVENT_KINDS.WEB_SEARCH,
              HISTORY_MATCH_FIELDS.CONTENT,
              result.url
            )
          );
        }
        break;
      }
      case CLI_EVENT_TYPES.COMPACTION:
        candidates.push(
          ...this.toCandidate(
            HISTORY_EVENT_KINDS.COMPACTION,
            HISTORY_MATCH_FIELDS.CONTENT,
            this.getStringValue((event.data as { summary?: unknown }).summary)
          )
        );
        break;
      default:
        break;
    }

    return candidates;
  }

  private toCandidate(
    eventKind: HistoryEventKind,
    matchField: HistoryMatchField,
    text: string | undefined,
    filePath?: string
  ): MatchCandidate[] {
    if (!text || text.length === 0) {
      return [];
    }
    const maxTextLength = this.options.maxTextLength;
    const capped =
      typeof maxTextLength === "number" && text.length > maxTextLength
        ? text.slice(0, maxTextLength)
        : text;
    return [{ eventKind, matchField, text: capped, filePath }];
  }

  private flattenStructuredPatch(structuredPatch: unknown): string | undefined {
    if (!Array.isArray(structuredPatch)) {
      return undefined;
    }

    const lines = structuredPatch.flatMap((hunk) => {
      if (!hunk || typeof hunk !== "object") {
        return [];
      }
      const hunkLines = (hunk as { lines?: unknown }).lines;
      return Array.isArray(hunkLines)
        ? hunkLines.filter((line): line is string => typeof line === "string")
        : [];
    });

    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  private getStringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private stringifyValue(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}
