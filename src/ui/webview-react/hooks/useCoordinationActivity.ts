import { useWorkflowStore } from "@store/workflowStore";
import type {
  CoordinationEntry,
  CoordinationParticipant,
} from "@root/types/CtrlYokeTypes";

const EMPTY_PARTICIPANTS: CoordinationParticipant[] = [];
const EMPTY_ENTRIES: CoordinationEntry[] = [];

/** Read the owning store's stable coordination projection for the activity panel. */
export function useCoordinationActivity() {
  const scope = useWorkflowStore((state) => state.coordinationScope);
  return {
    scope,
    participants: scope?.participants ?? EMPTY_PARTICIPANTS,
    entries: scope?.entries ?? EMPTY_ENTRIES,
  };
}
