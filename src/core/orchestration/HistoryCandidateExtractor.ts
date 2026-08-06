import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import type { CliOutput, CliEvent } from "../../types/WebviewMessageTypes";
import type { HistorySearchResult } from "../../types/WorkflowTimelineTypes";

export interface MatchCandidate {
  matchType: HistorySearchResult["matchType"];
  text: string;
  filePath?: string;
}

export interface HistoryCandidateExtractorOptions {
  maxTextLength?: number;
}

export class HistoryCandidateExtractor {
  constructor(
    private readonly options: HistoryCandidateExtractorOptions = {}
  ) {}

  collectCliOutputCandidates(cliOutput: CliOutput): MatchCandidate[] {
    const candidates: MatchCandidate[] = [
      ...this.toCandidate("prompt", cliOutput.prompt),
      ...this.toCandidate("response", cliOutput.response),
      ...this.toCandidate("bash", cliOutput.cliCommand),
    ];

    for (const structuredEvent of cliOutput.structured?.events ?? []) {
      candidates.push(
        ...this.collectStructuredEventCandidates(structuredEvent)
      );
    }

    return candidates;
  }

  collectStatusCandidates(message: string): MatchCandidate[] {
    return this.toCandidate("status", message);
  }

  private collectStructuredEventCandidates(event: CliEvent): MatchCandidate[] {
    const candidates: MatchCandidate[] = [];
    switch (event.type) {
      case CLI_EVENT_TYPES.TEXT:
        candidates.push(
          ...this.toCandidate(
            "response",
            this.getStringValue((event.data as { text?: unknown }).text)
          )
        );
        break;
      case CLI_EVENT_TYPES.THINKING:
        candidates.push(
          ...this.toCandidate(
            "response",
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
          ...this.toCandidate("bash", this.getStringValue(data.command))
        );
        candidates.push(
          ...this.toCandidate("bash", this.getStringValue(data.output))
        );
        candidates.push(
          ...this.toCandidate("bash", this.getStringValue(data.error))
        );
        break;
      }
      case CLI_EVENT_TYPES.FILE_READ:
      case CLI_EVENT_TYPES.FILE_WRITE:
      case CLI_EVENT_TYPES.FILE_EDIT:
      case CLI_EVENT_TYPES.FILE_DELETE: {
        const data = event.data as {
          path?: unknown;
          structuredPatch?: unknown;
        };
        const filePath = this.getStringValue(data.path);
        candidates.push(...this.toCandidate("file", filePath, filePath));
        if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
          candidates.push(
            ...this.toCandidate(
              "diff",
              this.flattenStructuredPatch(data.structuredPatch),
              filePath
            )
          );
        }
        break;
      }
      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const data = event.data as { server?: unknown; tool?: unknown };
        candidates.push(
          ...this.toCandidate("tool", this.getStringValue(data.server))
        );
        candidates.push(
          ...this.toCandidate("tool", this.getStringValue(data.tool))
        );
        break;
      }
      case CLI_EVENT_TYPES.TOOL_CALL: {
        const data = event.data as { name?: unknown; parameters?: unknown };
        candidates.push(
          ...this.toCandidate("tool", this.getStringValue(data.name))
        );
        candidates.push(
          ...this.toCandidate("tool", this.stringifyValue(data.parameters))
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
          ...this.toCandidate("tool", this.getStringValue(result?.output))
        );
        candidates.push(
          ...this.toCandidate("tool", this.getStringValue(result?.error))
        );
        break;
      }
      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as {
          query?: unknown;
          results?: Array<{ title?: string; snippet?: string; url?: string }>;
        };
        candidates.push(
          ...this.toCandidate("tool", this.getStringValue(data.query))
        );
        for (const result of data.results ?? []) {
          candidates.push(...this.toCandidate("response", result.title));
          candidates.push(...this.toCandidate("response", result.snippet));
          candidates.push(...this.toCandidate("response", result.url));
        }
        break;
      }
      case CLI_EVENT_TYPES.COMPACTION:
        candidates.push(
          ...this.toCandidate(
            "response",
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
    matchType: HistorySearchResult["matchType"],
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
    return [{ matchType, text: capped, filePath }];
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
