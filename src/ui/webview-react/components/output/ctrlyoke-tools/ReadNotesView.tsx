import React from "react";
import type { ToolResult } from "../../../types/cliEvents";
import { COORDINATION_ENTRY_KINDS } from "@root/types/DashboardConstants";
import { COORDINATION_UNTRUSTED_LABEL } from "@root/utils/ctrlyokeToolViews/coordinationPresentation";
import { RawToolCallSection } from "./RawToolCallSection";
import { MarkdownText } from "@components/output/MarkdownText";
import type {
  ToolCallExpansionSection,
  ToolCallExpansionState,
} from "@utils/toolCallLayout";
import type { RowFindDecoration } from "@utils/outputFind";
import type {
  ReadNotesParams,
  ReadNotesResult,
} from "@root/utils/ctrlyokeToolViews/readNotesModel";
import { readNotesEntryText } from "@root/utils/ctrlyokeToolViews/readNotesModel";
import { coordinationEntrySearchText } from "@root/utils/ctrlyokeToolViews/coordinationPresentation";
import { sliceFindMatches } from "./shared";

export const ReadNotesBody: React.FC<{
  params?: ReadNotesParams;
  result: ReadNotesResult;
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  genericResult?: ToolResult;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  findDecorations?: RowFindDecoration;
  bodyFindDecorations?: RowFindDecoration[];
  findQuery?: string;
  findCaseSensitive?: boolean;
}> = ({
  params: _params,
  result,
  server,
  tool,
  parameters,
  genericResult,
  expansion,
  onExpansionChange,
  findDecorations,
  bodyFindDecorations,
  findQuery,
  findCaseSensitive,
}) => (
  <div className="space-y-2">
    <ol className="list-none space-y-2 p-0">
      {result.entries.map((entry, index) => {
        const entrySearchText = coordinationEntrySearchText(entry);
        const entryDecorations =
          bodyFindDecorations?.[index] ?? findDecorations;
        const noteStart = Math.max(
          0,
          entrySearchText.lastIndexOf(entry.text ?? "")
        );
        return (
          <li key={entry.seq}>
            <div className="font-medium">{readNotesEntryText(entry)}</div>
            {entry.kind === COORDINATION_ENTRY_KINDS.NOTE &&
              entry.text !== undefined && (
                <div
                  className="whitespace-pre-wrap wrap-break-word"
                  data-untrusted-content="true"
                  aria-label={COORDINATION_UNTRUSTED_LABEL}
                >
                  <MarkdownText
                    findDecorations={{
                      matches: sliceFindMatches(
                        entryDecorations?.matches,
                        noteStart,
                        entry.text.length
                      ),
                    }}
                    highlightQuery={
                      entryDecorations?.matches.length ? findQuery : undefined
                    }
                    highlightCaseSensitive={findCaseSensitive}
                    highlightActiveIndex={
                      entryDecorations?.matches.findIndex(
                        (match) => match.active
                      ) ?? -1
                    }
                  >
                    {entry.text}
                  </MarkdownText>
                </div>
              )}
          </li>
        );
      })}
    </ol>
    <RawToolCallSection
      server={server}
      tool={tool}
      parameters={parameters}
      result={genericResult}
      expansion={expansion}
      onExpansionChange={onExpansionChange}
    />
  </div>
);
