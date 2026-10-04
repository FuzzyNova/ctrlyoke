import React from "react";
import type { ToolResult } from "../../../types/cliEvents";
import { ATOMIC_REFERENCE_KINDS } from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { openContextReference } from "@utils/contextReferenceActions";
import { RawToolCallSection } from "./RawToolCallSection";
import type {
  ToolCallExpansionSection,
  ToolCallExpansionState,
} from "@utils/toolCallLayout";
import type {
  ReleasePathsParams,
  ReleasePathsResult,
} from "@root/utils/ctrlyokeToolViews/releasePathsModel";

export const ReleasePathsBody: React.FC<{
  params?: ReleasePathsParams;
  result: ReleasePathsResult;
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  genericResult?: ToolResult;
  expansion: ToolCallExpansionState;
  onExpansionChange: (
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
}> = ({
  params: _params,
  result,
  server,
  tool,
  parameters,
  genericResult,
  expansion,
  onExpansionChange,
}) => {
  const vscode = getVsCodeApi();
  return (
    <div className="space-y-1">
      {result.released.length > 0 && (
        <ul className="m-0 list-none space-y-0.5 p-0">
          {result.released.map((path) => (
            <li key={path}>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-link-fg hover:text-link-active-fg hover:underline font-inherit text-left"
                onClick={() =>
                  openContextReference(
                    { type: ATOMIC_REFERENCE_KINDS.FILE, path },
                    vscode
                  )
                }
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      )}
      {result.notHeld.length > 0 && (
        <div className="text-description-fg">
          Not held: {result.notHeld.join(", ")}
        </div>
      )}
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
};
