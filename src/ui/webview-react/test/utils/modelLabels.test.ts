import { describe, expect, it } from "vitest";
import {
  MODEL_NONE_LABELS,
  MODEL_NONE_OPTION,
} from "@root/types/DashboardConstants";
import { modelSummaryLabel } from "@utils/modelLabels";

const models = [{ ...MODEL_NONE_OPTION }, { value: "sonnet", label: "Sonnet" }];

describe("modelSummaryLabel", () => {
  it("reads none as Harness default instead of the option's full label", () => {
    expect(modelSummaryLabel(MODEL_NONE_OPTION.value, models)).toBe(
      MODEL_NONE_LABELS.SHORT
    );
  });

  it("uses a known model's label", () => {
    expect(modelSummaryLabel("sonnet", models)).toBe("Sonnet");
  });

  it("shows an unknown id as itself", () => {
    expect(modelSummaryLabel("custom-model", models)).toBe("custom-model");
  });
});
