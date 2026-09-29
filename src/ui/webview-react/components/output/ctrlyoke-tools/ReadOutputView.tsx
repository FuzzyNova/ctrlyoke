import React from "react";
import { MarkdownText } from "@components/output/MarkdownText";
import { RawToolCallSection } from "./RawToolCallSection";
import { highlightText } from "@utils/outputFind";
import { readOutputExpansionSection } from "@root/types/DashboardConstants";
import {
  readOutputItemSearchText,
  type ReadOutputParams,
  type ReadOutputResult,
} from "./readOutputModel";
import type { ToolViewBodyProps } from "./WorkflowStatusView";
export const ReadOutputBody: React.FC<ToolViewBodyProps> = ({
  params,
  result,
  data,
  expansion,
  onExpansionChange,
  findDecorations,
  paramsFindMatches,
  outputFindMatches,
  errorFindMatches,
}) => {
  const p = params as ReadOutputParams | undefined;
  const output = result as ReadOutputResult;
  let offset = 0;
  return (
    <div className="space-y-2 text-[length:var(--cy-output-font-size-sm)]">
      {output.outputs.map((item) => {
        const heading = `#${item.index + 1} · ${item.prompt.split(/\r?\n/, 1)[0]} · ${item.status}`;
        const start = offset;
        const searchableLine = readOutputItemSearchText(item, p);
        offset += searchableLine.length + 1;
        const expanded =
          expansion.readOutputExpanded?.[String(item.index)] ?? false;
        const matchesFor = (fieldStart: number, length: number) =>
          (findDecorations?.matches ?? [])
            .filter(
              (match) =>
                match.start < fieldStart + length && match.end > fieldStart
            )
            .map((match) => ({
              ...match,
              start: Math.max(0, match.start - fieldStart),
              end: Math.min(length, match.end - fieldStart),
            }));
        const responseStart = start + heading.length + 1;
        const footer = [
          p?.cursor ? `Cursor ${p.cursor}` : "",
          p?.tail !== undefined ? `Tail ${p.tail}` : "",
          item.nextCursor ? `Next cursor ${item.nextCursor}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const footerStart =
          responseStart +
          (item.responseText?.length ?? 0) +
          (item.responseText ? 1 : 0);
        return (
          <section
            key={item.index}
            className="rounded border border-border/50 p-2"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 bg-transparent p-0 text-left"
              aria-expanded={expanded}
              onClick={() =>
                onExpansionChange(
                  readOutputExpansionSection(item.index),
                  !expanded
                )
              }
            >
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
              <span className="min-w-0 flex-1 break-words">
                {highlightText(heading, matchesFor(start, heading.length))}
              </span>
            </button>
            {expanded && item.responseText !== null && (
              <div className="mt-2 break-words">
                <MarkdownText
                  findDecorations={{
                    matches: matchesFor(
                      responseStart,
                      item.responseText.length
                    ),
                  }}
                >
                  {item.responseText}
                </MarkdownText>
              </div>
            )}
            {expanded && item.responseText === null && (
              <div className="mt-2 text-muted-foreground">
                No output recorded
              </div>
            )}
            {footer && (
              <div className="mt-2 text-muted-foreground">
                {highlightText(footer, matchesFor(footerStart, footer.length))}
              </div>
            )}
          </section>
        );
      })}
      <RawToolCallSection
        data={data}
        paramsFindMatches={paramsFindMatches}
        outputFindMatches={outputFindMatches}
        errorFindMatches={errorFindMatches}
        expansion={expansion}
        onExpansionChange={onExpansionChange}
        buttonClassName="text-bash-expand-link cursor-pointer bg-transparent p-0 text-[length:var(--cy-output-font-size-sm)] hover:underline"
      />
    </div>
  );
};
