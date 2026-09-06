import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { HarnessColorSettings } from "@root/types/CtrlYokeSettings";
import {
  HARNESS_CHART_COLORS,
  SCRIPT_STEP_DEFAULT_COLOR,
  STEP_COLOR_TIE_BREAK_PALETTE,
  STEP_COLOR_MODES,
  type HarnessId,
  type StepColorMode,
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
  /** Effective mode controlling whether step identity colors are rendered. */
  stepColorMode?: StepColorMode;
  /** Effective dashboard settings for identity colors. */
  settings?: HarnessColorSettings;
  /** Group members let the resolver identify a genuine baseline-color collision. */
  groupMembers?: readonly StepColorGroupMember[];
}

/** Return the theme fallback as a valid value for an HTML color input. */
export function getHarnessStepColorPickerValue(harnessId: HarnessId): string {
  return (
    /#[0-9a-fA-F]{6}/.exec(HARNESS_CHART_COLORS[harnessId])?.[0] ?? "#808080"
  );
}

/**
 * Resolve the inherited step color to a value accepted by an HTML color input.
 * Theme-aware built-ins contain a CSS variable with a hex fallback, while
 * configured colors are already validated hex strings.
 */
export function getInheritedStepColor(
  harnessId: HarnessId | undefined,
  settings?: HarnessColorSettings
): string {
  const configuredColor = harnessId
    ? settings?.byHarness[harnessId]
    : settings?.script;
  if (configuredColor) return configuredColor;

  return harnessId
    ? getHarnessStepColorPickerValue(harnessId)
    : /#[0-9a-fA-F]{6}/.exec(SCRIPT_STEP_DEFAULT_COLOR)?.[0] ?? "#808080";
}

/**
 * Resolve the identity color for a harness (or script steps, when `harnessId`
 * is undefined) from the user's overrides, falling back to the built-in
 * theme-aware chart colors. This is the single source every surface that
 * paints a harness color — the steps panel, chip rail, output pane, and the
 * workspace stats harness-share bar — must read through, so they can never
 * drift from each other or from a step's own resolved color.
 */
export function resolveHarnessColor(
  harnessId: HarnessId | undefined,
  settings?: HarnessColorSettings
): string {
  const configuredColor = harnessId
    ? settings?.byHarness[harnessId]
    : settings?.script;
  return (
    configuredColor ??
    (harnessId && HARNESS_CHART_COLORS[harnessId]) ??
    SCRIPT_STEP_DEFAULT_COLOR
  );
}

function getBaseStepColor(
  step: WorkflowStep,
  harnessId: HarnessId | undefined,
  settings?: HarnessColorSettings
): string {
  return step.color ?? resolveHarnessColor(harnessId, settings);
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
 * workflow/global harness resolver. Authored colors take precedence over
 * dashboard settings and parallel-group tie-break colors.
 */
export function resolveStepColor({
  step,
  harnessId,
  group,
  offsetInGroup,
  stepColorMode,
  settings,
  groupMembers,
}: ResolveStepColorOptions): string | undefined {
  if (stepColorMode === STEP_COLOR_MODES.OFF) return undefined;

  const authoredColor = step.color;
  if (authoredColor) return authoredColor;

  const baseColor = resolveHarnessColor(harnessId, settings);
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
    .map((member) => getBaseStepColor(member.step, member.harnessId, settings));
  if (!siblingBaseColors.includes(baseColor)) return baseColor;

  return getTieBreakColor(group, offsetInGroup, baseColor, siblingBaseColors);
}
