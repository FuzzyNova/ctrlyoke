import { isStandalone } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import { parseRoute } from "./route";

export function getReadyPreferredWorkingFilePath(): string | undefined {
  if (isStandalone) {
    return parseRoute(window.location.search).workflow;
  }

  return useUiStore.getState().activeWorkflowWorkingFilePath ?? undefined;
}
