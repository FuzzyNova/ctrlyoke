import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import type {
  ClearScheduleMessage,
  SetScheduleMessage,
} from "@root/types/WebviewMessageTypes";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";

type PostMessage = (message: SetScheduleMessage | ClearScheduleMessage) => void;

/** Posts a schedule request; hostId is assigned by the extension host. */
export function postSetSchedule(
  postMessage: PostMessage,
  address: WorkflowViewAddress,
  schedule: Omit<SetScheduleMessage, "type" | "address">
): void {
  postMessage({ type: MESSAGE_TYPES.SET_SCHEDULE, address, ...schedule });
}

export function postClearSchedule(
  postMessage: PostMessage,
  address: WorkflowViewAddress
): void {
  postMessage({ type: MESSAGE_TYPES.CLEAR_SCHEDULE, address });
}
