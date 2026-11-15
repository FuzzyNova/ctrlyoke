import { FINAL_STEP_PHASES } from "../types/messages";
import type { OutputMessageTarget } from "./outputProjection";

export function buildUndoRecordKey(target: OutputMessageTarget): string {
  return target.kind === FINAL_STEP_PHASES.FINAL_STEP
    ? `finalStep-${target.index}`
    : `queue-${target.index}`;
}
