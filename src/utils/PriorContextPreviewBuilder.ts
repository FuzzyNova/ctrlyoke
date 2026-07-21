import { buildPriorContextXmlFromItems } from "../core/HarnessIntegration";
import { type PriorContext, type WorkflowStep } from "../types/CtrlYokeTypes";
import { RunOutputResolver } from "../core/orchestration/RunOutputResolver";

/**
 * Builds the exact XML preview a user will see in the editor when they
 * Ctrl+click an inline $prior-context reference ($previous, $step:N, etc.).
 *
 * Uses the same `buildPriorContextXmlFromItems` function as live harness
 * injection — if the XML format changes there, the preview changes too.
 */
export class PriorContextPreviewBuilder {
  /**
   * Build the <priorContext> XML preview for a given inline ref string.
   *
   * @param ref       The raw ref kind string, e.g. "previous", "step:1,3", "all"
   * @param stepCount Number of steps that precede the current prompt (0-based count)
   * @param steps     The workflow steps array from the working file
   * @returns XML string matching the actual injection format, or a comment when
   *          no context is available (step not yet run, or out-of-range index)
   */
  static async buildPreview(
    ref: string,
    stepCount: number,
    steps: readonly WorkflowStep[],
    resolver: RunOutputResolver,
    manifestPath: string
  ): Promise<string> {
    const context = PriorContextPreviewBuilder.toPriorContext(ref, stepCount);
    const items = await resolver.resolvePriorContextItems(
      manifestPath,
      [context],
      steps,
      stepCount
    );

    if (items.length === 0) {
      return `<!-- $${ref}: no prior context available at this step position (step output may not have run yet) -->`;
    }

    return buildPriorContextXmlFromItems(items);
  }

  private static toPriorContext(ref: string, stepCount: number): PriorContext {
    if (ref === "finalStep") return "finalStepPrevious";
    if (ref === "allFinalStep") return "finalStepAll";
    if (ref === "previous" || ref === "all") return ref;
    return PriorContextPreviewBuilder.resolveIndices(ref, stepCount).map(
      (index) => index + 1
    );
  }

  /** Convert a ref string to 0-based step indices. */
  private static resolveIndices(ref: string, stepCount: number): number[] {
    if (ref === "previous") {
      return stepCount > 0 ? [stepCount - 1] : [];
    }
    if (ref === "all") {
      return stepCount > 0
        ? Array.from({ length: stepCount }, (_, i) => i)
        : [];
    }
    if (ref.startsWith("step:")) {
      const rangeText = ref.slice("step:".length);
      const indices = new Set<number>();
      for (const part of rangeText.split(",")) {
        const rangeParts = part.match(/^(\d+)-(\d+)$/);
        if (rangeParts) {
          const start = parseInt(rangeParts[1], 10);
          const end = parseInt(rangeParts[2], 10);
          for (let i = start; i <= end; i++) {
            if (i >= 1 && i <= stepCount) indices.add(i - 1);
          }
        } else if (/^\d+$/.test(part)) {
          const n = parseInt(part, 10);
          if (n >= 1 && n <= stepCount) indices.add(n - 1);
        }
      }
      return [...indices];
    }
    return [];
  }
}
