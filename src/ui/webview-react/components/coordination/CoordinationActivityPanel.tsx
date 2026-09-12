import React from "react";
import { useCoordinationActivity } from "@hooks/useCoordinationActivity";
import {
  coordinationEntrySummary,
  coordinationParticipantAttribution,
} from "@utils/coordinationPresentation";

export const CoordinationActivityPanel: React.FC = () => {
  const { scope, participants, entries } = useCoordinationActivity();
  if (!scope) return null;

  return (
    <aside
      className="mx-2 my-1 max-h-52 flex-shrink-0 overflow-y-auto rounded border border-panel-border bg-sidebar-bg/50 px-2 py-1.5 text-[length:var(--fp-output-font-size-xs)]"
      aria-label="Execution-root coordination"
      data-coordination-panel="true"
    >
      <div className="font-semibold text-[var(--fg-primary)]">
        Execution-root coordination
      </div>
      <div className="truncate text-description-fg" title={scope.executionRoot}>
        {scope.identity}
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
        <div className="text-description-fg">No recent coordination entries</div>
      ) : (
        <ul className="m-0 list-none space-y-1 p-0" data-untrusted-content="true">
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
