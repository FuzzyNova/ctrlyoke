import { isStandalone } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import { parseRoute } from "./route";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";

export function getReadyPreferredViewAddress(): WorkflowViewAddress | undefined {
  if (isStandalone) {
    return parseRoute(window.location.search).workflow;
  }

  return useUiStore.getState().displayedViewAddress ?? undefined;
}
