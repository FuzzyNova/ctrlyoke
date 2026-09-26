import type { CoordinationEntry } from "@root/types/CtrlYokeTypes";
import { COORDINATION_ENTRY_KINDS } from "@root/types/DashboardConstants";
import {
  getCoordinationAttribution,
  resolveCoordinationParticipantKind,
} from "@root/utils/CoordinationAttribution";

export const COORDINATION_UNTRUSTED_LABEL = "untrusted board content";

export function coordinationParticipantAttribution(
  participant: Pick<
    CoordinationEntry["from"],
    "label" | "attested" | "kind" | "address"
  >
): string {
  const attribution = getCoordinationAttribution(
    participant.label,
    participant.attested,
    resolveCoordinationParticipantKind(participant.kind, participant.address)
  );
  return `${attribution.label} (${attribution.description})`;
}

/** Plain text only: board notes must never be interpreted as Markdown or UI instructions. */
export function coordinationEntrySummary(entry: CoordinationEntry): string {
  switch (entry.kind) {
    case COORDINATION_ENTRY_KINDS.NOTE:
      return `Note (${COORDINATION_UNTRUSTED_LABEL}): ${entry.text ?? ""}`;
    case COORDINATION_ENTRY_KINDS.CLAIM:
      return `Claimed ${entry.paths?.join(", ") || "workspace paths"}${entry.reason ? ` — ${entry.reason}` : ""}`;
    case COORDINATION_ENTRY_KINDS.RELEASE:
      return `Released ${entry.paths?.join(", ") || "workspace paths"}${entry.reason ? ` — ${entry.reason}` : ""}`;
    case COORDINATION_ENTRY_KINDS.JOIN:
      return "Joined the execution-root coordination scope";
    case COORDINATION_ENTRY_KINDS.LEAVE:
      return "Left the execution-root coordination scope";
  }
}

export function coordinationEntrySearchText(entry: CoordinationEntry): string {
  return `${coordinationParticipantAttribution(entry.from)} ${coordinationEntrySummary(entry)}`;
}
