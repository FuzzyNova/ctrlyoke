import {
  type PriorContextItem,
  buildPriorContextXmlFromItems,
} from "../core/HarnessIntegration";
import { type WorkflowStep, isScriptStep } from "../types/CtrlYokeTypes";

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
  static buildPreview(
    ref: string,
    stepCount: number,
    steps: WorkflowStep[]
  ): string {
    if (ref === "finalStep" || ref === "allFinalStep") {
      return `<!-- $${ref}: final-step output is not stored in the queue working file and cannot be previewed here -->`;
    }

    const items = PriorContextPreviewBuilder.gatherItemsForRef(
      ref,
      stepCount,
      steps
    );

    if (items.length === 0) {
      return `<!-- $${ref}: no prior context available at this step position (step output may not have run yet) -->`;
    }

    return buildPriorContextXmlFromItems(items);
  }

  private static gatherItemsForRef(
    ref: string,
    stepCount: number,
    steps: WorkflowStep[]
  ): PriorContextItem[] {
    const targetIndices = PriorContextPreviewBuilder.resolveIndices(
      ref,
      stepCount
    );

    return targetIndices
      .map((i): PriorContextItem | null => {
        const step = steps[i];
        if (!step) return null;

        if (isScriptStep(step)) {
          const scriptOutput = step._runtime?.scriptOutput;
          if (!scriptOutput) return null;
          return {
            index: i,
            name: step.name,
            text: [
              scriptOutput.stdout,
              scriptOutput.stderr,
              scriptOutput.exitCode !== undefined
                ? String(scriptOutput.exitCode)
                : "",
            ]
              .filter(Boolean)
              .join("\n")
              .trim(),
            scriptOutput,
          };
        }

        const responseText = step._runtime?.responseText ?? "";
        return {
          index: i,
          name: step.name,
          prompt: step.prompt,
          text: responseText,
        };
      })
      .filter((item): item is PriorContextItem => item !== null);
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
