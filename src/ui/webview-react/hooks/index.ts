/**
 * Hooks index - exports all React hooks
 */

export { useVsCodeApi, getVsCodeApi, isStandalone } from "./useVsCodeApi";
export {
  useMessageHandler,
  sendMessage,
  type UseMessageHandlerReturn,
} from "./useMessageHandler";
export {
  useCompatibilityDiagnostics,
  type UseCompatibilityDiagnosticsResult,
  type UseCompatibilityDiagnosticsOptions,
} from "./useCompatibilityDiagnostics";
export { useMediaQuery, useIsMobile, useIsNarrowMobile } from "./useMediaQuery";
export { useIosVisualViewportRootStyle } from "./useIosVisualViewportRootStyle";
export {
  useElementNarrow,
  useElementResizeActivity,
  useElementTier,
} from "./useElementNarrow";
export { useUndoRedoKeyHandler } from "./useUndoRedoKeyHandler";
export { useNewWorkflowKeyHandler } from "./useNewWorkflowKeyHandler";
export { useHistorySearchKeyHandler } from "./useHistorySearchKeyHandler";
export { useDrawerTabOverrides } from "./useDrawerTabOverrides";
export { useSettingsDrawerTabOverrides } from "./useSettingsDrawerTabOverrides";
export { usePromptStatus } from "./usePromptStatus";
export { useContextPct } from "./useContextPct";
export { useStepClickHandler } from "./useStepClickHandler";
export {
  useBulkSelectionGates,
  useStepCapabilityContext,
} from "./useBulkSelectionGates";
export {
  useStepContextMenu,
  usePasteToEndContextMenu,
} from "./useStepContextMenu";
export { useFinalStepContextMenu } from "./useFinalStepContextMenu";
export {
  useWorkflowContextMenu,
  type WorkflowContextMenuTarget,
} from "./useWorkflowContextMenu";
export { useLongPress } from "./useLongPress";
export { useSortableDndSensors } from "./useSortableDndSensors";
export {
  useLatestStepOutput,
  useFinalStepLatestOutput,
} from "./useLatestStepOutput";
export { useIsViewingDeletedWorkflow } from "./useIsViewingDeletedWorkflow";
export { useIsSystemGeneratedWorkflow } from "./useIsSystemGeneratedWorkflow";
export { useActiveWorkflowExternalOwner } from "./useActiveWorkflowExternalOwner";
export {
  useRunDispatchTargets,
  type RunDispatchTarget,
  type RunDispatchTargets,
} from "./useRunDispatchTargets";
export {
  useHideableOptions,
  type HideablePartition,
} from "./useHideableOptions";
