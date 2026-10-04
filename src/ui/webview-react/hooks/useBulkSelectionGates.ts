import { useMemo } from "react";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { BULK_EDIT_DISABLED_REASONS } from "@root/types/DashboardConstants";
import {
  findSelectedIndexLacking,
  getBulkPromptPropertyDisabledReason,
  getSelectionCapabilities,
  getStepCapabilityDisabledReason,
  STEP_CAPABILITY_ACTIONS,
  type StepCapabilities,
  type StepCapabilityContext,
} from "../utils/stepCapabilities";
import { executionOwnsCurrentStep } from "../utils/status";
import { useActiveWorkflowExternalOwner } from "./useActiveWorkflowExternalOwner";
import { useIsSystemGeneratedWorkflow } from "./useIsSystemGeneratedWorkflow";
import { useIsViewingDeletedWorkflow } from "./useIsViewingDeletedWorkflow";

const EMPTY_INDICES: readonly number[] = [];

/**
 * The single source for the capability context of a set of selected queue
 * indices. Every bulk control (editor header, footer, drawer, drag) must build
 * its context here so they agree on which facts lock a step.
 */
export function useStepCapabilityContext(
  indices: readonly number[]
): StepCapabilityContext {
  const currentStep = useWorkflowStore((s) => s.currentStep);
  const executionState = useWorkflowStore((s) => s.executionState);
  const finalStepPhase = useWorkflowStore((s) => s.finalStepPhase);
  const parallelGroups = useWorkflowStore((s) => s.parallelGroups);
  const totalSteps = useWorkflowStore((s) => s.steps.length);
  const pendingRewindBoundary = useUiStore(
    (s) => s.pendingRewind?.fromStepIndex
  );
  const isExternallyManaged = useActiveWorkflowExternalOwner() != null;
  const isViewingDeletedWorkflow = useIsViewingDeletedWorkflow();
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();
  const isReadOnly =
    isExternallyManaged ||
    isViewingDeletedWorkflow ||
    isSystemGeneratedWorkflow;

  return useMemo(
    () => ({
      currentStep,
      executionState,
      pendingRewindBoundary,
      isExternallyManaged: isReadOnly,
      isExecutionTargetLocked:
        executionOwnsCurrentStep(executionState, finalStepPhase) &&
        indices.includes(currentStep),
      totalSteps,
      parallelGroups,
    }),
    [
      currentStep,
      executionState,
      finalStepPhase,
      indices,
      isReadOnly,
      parallelGroups,
      pendingRewindBoundary,
      totalSteps,
    ]
  );
}

export interface BulkSelectionGates {
  isBulkMode: boolean;
  indices: readonly number[];
  context: StepCapabilityContext;
  /** Null outside bulk mode. */
  capabilities: StepCapabilities | null;
  /** Some selected step is completed, running or otherwise locked. */
  hasLockedStep: boolean;
  promptPropertyDisabledReason: string | undefined;
  toggleDisabledReason: string | undefined;
  /** Set when harness-scoped option lists (model, agent, skills, permissions) have no single source. */
  harnessScopedDisabledReason: string | undefined;
}

/** Live capability gates for the current multi-selection (spec §2, §7). */
export function useBulkSelectionGates(): BulkSelectionGates {
  const indices = useEditorStore(
    (s) => s.multiSelection?.indices ?? EMPTY_INDICES
  );
  const bulkPatch = useEditorStore((s) => s.bulkPatch);
  const steps = useWorkflowStore((s) => s.steps);
  const workflowHarness = useSettingsStore((s) => s.workflowProperties.harness);
  const globalHarness = useSettingsStore((s) => s.globalSettings.harness);
  const context = useStepCapabilityContext(indices);
  // Same rule every bulk control uses: a non-null multiSelection is bulk mode.
  const isBulkMode = useEditorStore((s) => s.multiSelection !== null);

  return useMemo(() => {
    if (!isBulkMode) {
      return {
        isBulkMode,
        indices,
        context,
        capabilities: null,
        hasLockedStep: false,
        promptPropertyDisabledReason: undefined,
        toggleDisabledReason: undefined,
        harnessScopedDisabledReason: undefined,
      };
    }
    const capabilities = getSelectionCapabilities(indices, steps, context);
    const firstLockedIndex = findSelectedIndexLacking(
      indices,
      steps,
      context,
      "canToggleEnabled"
    );
    const effectiveHarnesses = indices.map(
      (index) =>
        (steps[index] as { harness?: string } | undefined)?.harness ??
        workflowHarness ??
        globalHarness
    );
    const harnessesDiffer = effectiveHarnesses.some(
      (harness) => harness !== effectiveHarnesses[0]
    );
    const patchSetsHarness = Object.prototype.hasOwnProperty.call(
      bulkPatch,
      "harness"
    );
    return {
      isBulkMode,
      indices,
      context,
      capabilities,
      hasLockedStep: firstLockedIndex !== undefined,
      promptPropertyDisabledReason: getBulkPromptPropertyDisabledReason(
        indices,
        steps,
        context
      ),
      toggleDisabledReason:
        firstLockedIndex === undefined
          ? undefined
          : (getStepCapabilityDisabledReason(
              context,
              STEP_CAPABILITY_ACTIONS.TOGGLE,
              firstLockedIndex,
              steps[firstLockedIndex]
            ) ?? BULK_EDIT_DISABLED_REASONS.LOCKED_STEPS),
      harnessScopedDisabledReason:
        harnessesDiffer && !patchSetsHarness
          ? BULK_EDIT_DISABLED_REASONS.HARNESS_REQUIRED
          : undefined,
    };
  }, [
    bulkPatch,
    context,
    globalHarness,
    indices,
    isBulkMode,
    steps,
    workflowHarness,
  ]);
}
