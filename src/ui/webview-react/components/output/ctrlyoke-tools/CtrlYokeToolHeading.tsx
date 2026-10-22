import React from "react";
import { formatMcpToolLabel } from "@root/utils/formatMcpToolLabel";
import {
  highlightText,
  type RowFindDecoration,
} from "../../../utils/outputFind";
import { CTRLYOKE_TOOL_HEADING_SEPARATOR } from "./registry";
import { sliceFindMatches } from "./shared";

interface CtrlYokeToolHeadingProps {
  server: string;
  tool: string;
  summary: string;
  warning: boolean;
  /** Matches against `ctrlYokeToolHeading(tool, summary)`. */
  findMatches: RowFindDecoration["matches"];
}

/**
 * Header for a ctrlyoke tool view: the tool the agent called, muted, then the
 * result summary. Its text is `ctrlYokeToolHeading(tool, summary)`, which is
 * what find-in-output and the height estimate measure.
 */
export const CtrlYokeToolHeading: React.FC<CtrlYokeToolHeadingProps> = ({
  server,
  tool,
  summary,
  warning,
  findMatches,
}) => {
  const summaryStart = tool.length + CTRLYOKE_TOOL_HEADING_SEPARATOR.length;
  return (
    <span
      className="min-w-0 wrap-anywhere"
      title={formatMcpToolLabel(server, tool)}
    >
      <span className="text-description-fg">
        {highlightText(tool, sliceFindMatches(findMatches, 0, tool.length))}
        {CTRLYOKE_TOOL_HEADING_SEPARATOR}
      </span>
      <span className={warning ? "text-warning-fg" : undefined}>
        {highlightText(
          summary,
          sliceFindMatches(findMatches, summaryStart, summary.length)
        )}
      </span>
    </span>
  );
};
