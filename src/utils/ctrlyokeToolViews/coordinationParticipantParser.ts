import type { CoordinationEntry } from "../../types/CtrlYokeTypes";
import { COORDINATION_PARTICIPANT_KINDS } from "../../types/DashboardConstants";
import { isRecord } from "./shared";

/** Parse the participant shape shared by coordination tool results. */
export function parseCoordinationParticipant(
  value: unknown
): CoordinationEntry["from"] | undefined {
  if (
    !isRecord(value) ||
    typeof value.participantId !== "string" ||
    typeof value.label !== "string" ||
    typeof value.attested !== "boolean" ||
    (value.kind !== undefined &&
      value.kind !== COORDINATION_PARTICIPANT_KINDS.CTRL_YOKE_STEP &&
      value.kind !== COORDINATION_PARTICIPANT_KINDS.EXTERNAL)
  )
    return undefined;

  return {
    participantId: value.participantId,
    label: value.label,
    attested: value.attested,
    ...(value.kind === undefined ? {} : { kind: value.kind }),
  };
}
