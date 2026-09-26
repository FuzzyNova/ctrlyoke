import { COORDINATION_PARTICIPANT_KINDS } from "../types/DashboardConstants";
import type { CoordinationParticipant } from "../types/CtrlYokeTypes";

export const COORDINATION_ATTESTED_STEP_DESCRIPTION =
  "attested ctrlyoke step";
export const COORDINATION_UNATTESTED_STEP_DESCRIPTION =
  "unattested ctrlyoke step (skill/CLI)";
export const COORDINATION_UNATTESTED_EXTERNAL_DESCRIPTION =
  "unattested external session";

export interface CoordinationAttribution {
  label: string;
  description: string;
}

/** Resolve the kind on older board entries, which predate the explicit field. */
export function resolveCoordinationParticipantKind(
  kind: CoordinationParticipant["kind"] | undefined,
  address?: CoordinationParticipant["address"]
): CoordinationParticipant["kind"] {
  return (
    kind ??
    (address
      ? COORDINATION_PARTICIPANT_KINDS.CTRL_YOKE_STEP
      : COORDINATION_PARTICIPANT_KINDS.EXTERNAL)
  );
}

/** Keep participant wording identical in MCP responses and dashboard views. */
export function getCoordinationAttribution(
  label: string,
  attested: boolean,
  kind: CoordinationParticipant["kind"]
): CoordinationAttribution {
  const description = attested
    ? COORDINATION_ATTESTED_STEP_DESCRIPTION
    : kind === COORDINATION_PARTICIPANT_KINDS.CTRL_YOKE_STEP
      ? COORDINATION_UNATTESTED_STEP_DESCRIPTION
      : COORDINATION_UNATTESTED_EXTERNAL_DESCRIPTION;

  return { label, description };
}
