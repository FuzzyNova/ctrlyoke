import { isRecord, tryParseJson } from "./shared";
import type { CoordinationParticipant } from "../../types/CtrlYokeTypes";
import { coordinationParticipantAttribution } from "./coordinationPresentation";
import { resolveCoordinationParticipantKind } from "../CoordinationAttribution";
import { parseCoordinationParticipant } from "./coordinationParticipantParser";

export interface ClaimPathsOwner {
  participantId: string;
  label: string;
  attested: boolean;
  kind: CoordinationParticipant["kind"];
}

export interface ClaimPathsDenied {
  path: string;
  owner: ClaimPathsOwner;
}

export interface ClaimPathsResult {
  granted: string[];
  denied: ClaimPathsDenied[];
}

export interface ClaimPathsParams {
  paths: string[];
  reason?: string;
}

function parseOwner(value: unknown): ClaimPathsOwner | undefined {
  const participant = parseCoordinationParticipant(value);
  if (!participant) return undefined;
  return {
    participantId: participant.participantId,
    label: participant.label,
    attested: participant.attested,
    kind: resolveCoordinationParticipantKind(participant.kind),
  };
}

export function parseClaimPathsParams(
  raw: unknown
): ClaimPathsParams | undefined {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.paths) ||
    !raw.paths.every((path) => typeof path === "string")
  )
    return undefined;
  return {
    paths: raw.paths,
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
  };
}

export function parseClaimPathsResultText(
  text: string
): ClaimPathsResult | undefined {
  try {
    const parsed: unknown = tryParseJson(text);
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.granted) ||
      !parsed.granted.every((path) => typeof path === "string") ||
      !Array.isArray(parsed.denied)
    )
      return undefined;
    const denied: ClaimPathsDenied[] = [];
    for (const item of parsed.denied) {
      if (!isRecord(item) || typeof item.path !== "string") return undefined;
      const owner = parseOwner(item.owner);
      if (!owner) return undefined;
      denied.push({ path: item.path, owner });
    }
    return { granted: parsed.granted, denied };
  } catch {
    return undefined;
  }
}

export function claimPathsSummary(
  _params: ClaimPathsParams | undefined,
  result: ClaimPathsResult
): string {
  const granted = result.granted.length;
  const denied = result.denied.length;
  if (denied > 0) return `Claimed ${granted}, ${denied} denied`;
  return `Claimed ${granted} ${granted === 1 ? "path" : "paths"}`;
}

export function claimPathsSearchText(
  params: ClaimPathsParams | undefined,
  result: ClaimPathsResult
): string[] {
  return [
    claimPathsSummary(params, result),
    [
      ...result.granted,
      ...result.denied.map(
        ({ path, owner }) =>
          `${path} — denied to ${coordinationParticipantAttribution(owner)}`
      ),
    ].join("\n"),
  ];
}
