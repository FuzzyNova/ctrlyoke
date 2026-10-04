import React from "react";
import { useCoordinationActivity } from "@hooks/useCoordinationActivity";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { ATOMIC_REFERENCE_KINDS } from "@root/types/DashboardConstants";
import { openContextReference } from "@utils/contextReferenceActions";
import {
  coordinationEntrySummary,
  coordinationParticipantAttribution,
} from "@root/utils/ctrlyokeToolViews/coordinationPresentation";
import { ActionButton } from "../shared/ActionButton";

/**
 * Scope-level view of the execution-root coordination board, rendered below the
 * coordination settings rather than beside the output/terminal panes: it
 * describes the execution root, not the open run, and most workflows never
 * attach the coordination tools at all. This panel is the board's only
 * dashboard surface: the output timeline shows a step's coordination activity
 * solely as that step's own MCP tool-call rows, so it follows the step's
 * hide/solo state.
 */
export const CoordinationActivityPanel: React.FC = () => {
  const { scope, participants, entries } = useCoordinationActivity();
  if (!scope) return null;

  return (
    <aside
      className="rounded border border-panel-border bg-sidebar-bg/50 px-3 py-2 text-xs"
      aria-label="Execution-root coordination"
      data-coordination-panel="true"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-[var(--fg-primary)]">
            Execution-root coordination board
          </div>
          <div
            className="truncate text-description-fg"
            title={scope.executionRoot}
          >
            {scope.identity}
          </div>
        </div>
        <ActionButton
          label="Open board file"
          icon="go-to-file"
          title={scope.boardPath}
          onClick={() =>
            openContextReference(
              { type: ATOMIC_REFERENCE_KINDS.FILE, path: scope.boardPath },
              getVsCodeApi()
            )
          }
        />
      </div>
      <div className="mt-1 text-description-fg" data-untrusted-content="true">
        {scope.attestationNotice}
      </div>

      <div className="mt-2 font-medium text-[var(--fg-secondary)]">
        Participants ({participants.length})
      </div>
      {participants.length === 0 ? (
        <div className="text-description-fg">No active participants</div>
      ) : (
        <ul className="m-0 list-none p-0">
          {participants.map((participant) => (
            <li key={participant.participantId} className="truncate">
              {coordinationParticipantAttribution(participant)}
              {participant.address?.stepName
                ? ` — ${participant.address.stepName}`
                : ""}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 font-medium text-[var(--fg-secondary)]">
        Recent entries
      </div>
      {entries.length === 0 ? (
        <div className="text-description-fg">
          No recent coordination entries
        </div>
      ) : (
        <ul
          className="m-0 max-h-52 list-none space-y-1 overflow-y-auto p-0"
          data-untrusted-content="true"
        >
          {[...entries].reverse().map((entry) => (
            <li key={entry.seq} className="whitespace-pre-wrap break-words">
              <span className="font-medium">
                {coordinationParticipantAttribution(entry.from)}
              </span>
              {`: ${coordinationEntrySummary(entry)}`}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
};
