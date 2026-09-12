import type { CoordinationEntry } from "@root/types/CtrlYokeTypes";
import { COORDINATION_ENTRY_KINDS } from "@root/types/DashboardConstants";

export const COORDINATION_UNTRUSTED_LABEL = "untrusted board content";
export const COORDINATION_ATTESTED_LABEL = "attested ctrlyoke step";
export const COORDINATION_UNATTESTED_LABEL = "unattested external session";

export function coordinationParticipantAttribution(
  participant: Pick<CoordinationEntry["from"], "label" | "attested">
): string {
  return `${participant.label} (${participant.attested ? COORDINATION_ATTESTED_LABEL : COORDINATION_UNATTESTED_LABEL})`;
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
