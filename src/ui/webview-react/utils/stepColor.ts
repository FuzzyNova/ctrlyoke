import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import {
  HARNESS_CHART_COLORS,
  SCRIPT_STEP_DEFAULT_COLOR,
  STEP_COLOR_TIE_BREAK_PALETTE,
  type HarnessId,
} from "@root/types/DashboardConstants";
import type { WorkflowStep } from "@store/workflowStore";

/** The information needed to compare one group member's base color. */
export interface StepColorGroupMember {
  step: WorkflowStep;
  harnessId?: HarnessId;
  offsetInGroup: number;
}

export interface ResolveStepColorOptions {
  step: WorkflowStep;
  /** The effective harness, already resolved by the owning surface. */
  harnessId?: HarnessId;
  group?: ParallelGroupDefinition;
  offsetInGroup?: number;
  /** Reserved for the settings-backed color overrides added in a later step. */
  settings?: unknown;
  /** Group members let the resolver identify a genuine baseline-color collision. */
  groupMembers?: readonly StepColorGroupMember[];
}

function getAuthoredStepColor(step: WorkflowStep): string | undefined {
  // `color` is intentionally read defensively until the authored step field is
  // added to the shared workflow contracts in the persistence step.
  if ("color" in step && typeof step.color === "string") {
    return step.color;
  }
  return undefined;
}

function getHarnessOrScriptColor(harnessId: HarnessId | undefined): string {
  return (
    (harnessId && HARNESS_CHART_COLORS[harnessId]) || SCRIPT_STEP_DEFAULT_COLOR
  );
}

function getBaseStepColor(
  step: WorkflowStep,
  harnessId: HarnessId | undefined
): string {
  return getAuthoredStepColor(step) ?? getHarnessOrScriptColor(harnessId);
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getTieBreakColor(
  group: ParallelGroupDefinition,
  offsetInGroup: number,
  baseColor: string,
  siblingBaseColors: readonly string[]
): string {
  const paletteLength = STEP_COLOR_TIE_BREAK_PALETTE.length;
  const start = hashSeed(`${group.id}:${offsetInGroup}`) % paletteLength;
  const forbiddenColors = new Set([baseColor, ...siblingBaseColors]);

  for (let attempt = 0; attempt < paletteLength; attempt += 1) {
    const candidate =
      STEP_COLOR_TIE_BREAK_PALETTE[(start + attempt) % paletteLength];
    if (!forbiddenColors.has(candidate)) return candidate;
  }

  // The palette is curated to avoid the built-in colors, but always return a
  // CSS color even if a future authored color exhausts the candidates.
  return STEP_COLOR_TIE_BREAK_PALETTE[start];
}

/**
 * Resolve the identity color for a workflow step.
 *
 * The caller supplies the effective harness because the webview has no shared
 * workflow/global harness resolver. Authored colors are read defensively for
 * the persistence step; settings are accepted as a forward-compatible slot
 * but intentionally unused until settings-backed overrides land.
 */
export function resolveStepColor({
  step,
  harnessId,
  group,
  offsetInGroup,
  groupMembers,
}: ResolveStepColorOptions): string {
  const authoredColor = getAuthoredStepColor(step);
  if (authoredColor) return authoredColor;

  const baseColor = getHarnessOrScriptColor(harnessId);
  const hasParallelMembers =
    group !== undefined && group.endIndex - group.startIndex + 1 >= 2;
  if (!hasParallelMembers || offsetInGroup === undefined) {
    return baseColor;
  }

  // The panel supplies members when it can inspect the whole group. A direct
  // resolver call still treats a parallel member as a collision candidate so
  // the documented group/offset signature remains useful on its own.
  if (!groupMembers) {
    return getTieBreakColor(group, offsetInGroup, baseColor, []);
  }

  const siblingBaseColors = groupMembers
    .filter((member) => member.offsetInGroup !== offsetInGroup)
    .map((member) => getBaseStepColor(member.step, member.harnessId));
  if (!siblingBaseColors.includes(baseColor)) return baseColor;

  return getTieBreakColor(group, offsetInGroup, baseColor, siblingBaseColors);
}
