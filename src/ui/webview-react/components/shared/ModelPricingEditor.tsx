import React, { useEffect, useMemo, useState } from "react";
import type {
  CtrlYokeGlobalSettings,
  ModelPricingOverride,
} from "@root/types/CtrlYokeSettings";
import { HARNESS_IDS, HARNESS_INFO } from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { Button } from "./Button";
import { CustomSelect, type SelectOption } from "./CustomSelect";
import { LocalNumberInput, LocalTextInput } from "./LocalInputs";
import { Icon } from "./Icon";

export type ModelPricingValue = CtrlYokeGlobalSettings["modelPricing"];

type PricingField = keyof ModelPricingOverride;

const HARNESS_ID_LIST = Object.values(HARNESS_IDS) as HarnessId[];
const OPTIONAL_RATE_FIELDS: readonly PricingField[] = [
  "cachedInputPerMTok",
  "cacheWritePerMTok",
  "reasoningPerMTok",
];
const UNKNOWN_TOKEN_SEMANTICS_HARNESSES = new Set<HarnessId>([
  HARNESS_IDS.QWEN_CLI,
  HARNESS_IDS.OPENCODE_CLI,
  HARNESS_IDS.ANTIGRAVITY_CLI,
]);

const RATE_FIELDS: readonly {
  key: PricingField;
  label: string;
  optional: boolean;
}[] = [
  { key: "inputPerMTok", label: "Input", optional: false },
  { key: "outputPerMTok", label: "Output", optional: false },
  { key: "cachedInputPerMTok", label: "Cached input", optional: true },
  { key: "cacheWritePerMTok", label: "Cache write", optional: true },
  { key: "reasoningPerMTok", label: "Reasoning", optional: true },
];

const EMPTY_OVERRIDE: ModelPricingOverride = {
  inputPerMTok: 0,
  outputPerMTok: 0,
};

function asEntries(
  value: ModelPricingValue | null | undefined
): Array<[HarnessId, Record<string, ModelPricingOverride>]> {
  return Object.entries(value ?? {}) as Array<
    [HarnessId, Record<string, ModelPricingOverride>]
  >;
}

function inputId(harnessId: HarnessId, modelId: string, field: PricingField) {
  return `model-pricing-${harnessId}-${modelId}-${field}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-"
  );
}

function isOptionalRateField(field: PricingField): boolean {
  return OPTIONAL_RATE_FIELDS.includes(field);
}

function updateObject(
  value: ModelPricingValue | null | undefined,
  harnessId: HarnessId,
  modelId: string,
  nextOverride: ModelPricingOverride
): ModelPricingValue {
  return {
    ...(value ?? {}),
    [harnessId]: {
      ...(value?.[harnessId] ?? {}),
      [modelId]: nextOverride,
    },
  };
}

export const ModelPricingEditor: React.FC<{
  value: ModelPricingValue | null | undefined;
  onChange: (value: ModelPricingValue) => void;
}> = ({ value, onChange }) => {
  const getModelsForHarness = useSettingsStore(
    (state) => state.getModelsForHarness
  );
  const [harnessToAdd, setHarnessToAdd] = useState<HarnessId>(
    HARNESS_ID_LIST[0]
  );
  const [modelDrafts, setModelDrafts] = useState<
    Partial<Record<HarnessId, string>>
  >({});

  const entries = useMemo(() => asEntries(value), [value]);
  const configuredHarnesses = useMemo(
    () => new Set(entries.map(([harnessId]) => harnessId)),
    [entries]
  );
  const harnessOptions = useMemo<SelectOption[]>(
    () =>
      HARNESS_ID_LIST.filter(
        (harnessId) => !configuredHarnesses.has(harnessId)
      ).map((harnessId) => ({
        value: harnessId,
        label: HARNESS_INFO[harnessId].name,
      })),
    [configuredHarnesses]
  );

  useEffect(() => {
    if (!harnessOptions.some((option) => option.value === harnessToAdd)) {
      const nextHarness = harnessOptions[0]?.value;
      if (nextHarness) setHarnessToAdd(nextHarness as HarnessId);
    }
  }, [harnessOptions, harnessToAdd]);

  const addHarness = () => {
    if (!harnessToAdd || configuredHarnesses.has(harnessToAdd)) return;
    onChange({ ...(value ?? {}), [harnessToAdd]: {} });
  };

  const removeHarness = (harnessId: HarnessId) => {
    const next = { ...(value ?? {}) };
    delete next[harnessId];
    onChange(next);
  };

  const addModel = (harnessId: HarnessId) => {
    const modelId = modelDrafts[harnessId]?.trim() ?? "";
    if (!modelId || value?.[harnessId]?.[modelId]) return;
    onChange(updateObject(value, harnessId, modelId, { ...EMPTY_OVERRIDE }));
    setModelDrafts((drafts) => ({ ...drafts, [harnessId]: "" }));
  };

  const removeModel = (harnessId: HarnessId, modelId: string) => {
    const models = { ...(value?.[harnessId] ?? {}) };
    delete models[modelId];
    const next = { ...(value ?? {}) };
    if (Object.keys(models).length === 0) {
      delete next[harnessId];
    } else {
      next[harnessId] = models;
    }
    onChange(next);
  };

  const updateRate = (
    harnessId: HarnessId,
    modelId: string,
    field: PricingField,
    rate: number | undefined
  ) => {
    const current = value?.[harnessId]?.[modelId];
    if (!current || (rate === undefined && !isOptionalRateField(field))) return;
    const nextOverride = { ...current };
    if (rate === undefined) {
      delete nextOverride[field];
    } else {
      nextOverride[field] = rate;
    }
    onChange(updateObject(value, harnessId, modelId, nextOverride));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label
            htmlFor="model-pricing-add-harness"
            className="mb-1 block text-xs text-description-fg"
          >
            Harness
          </label>
          <CustomSelect
            id="model-pricing-add-harness"
            value={harnessToAdd}
            onChange={(next) => setHarnessToAdd(next as HarnessId)}
            options={harnessOptions}
            disabled={harnessOptions.length === 0}
            triggerAriaLabel="Choose harness to add"
          />
        </div>
        <Button
          type="button"
          size="sm"
          onClick={addHarness}
          disabled={!harnessToAdd || harnessOptions.length === 0}
        >
          Add harness
        </Button>
      </div>

      {entries.length === 0 && (
        <p className="text-xs text-description-fg italic">
          No model pricing overrides configured.
        </p>
      )}

      {entries.map(([harnessId, models]) => {
        const discoveredModels = getModelsForHarness(harnessId);
        const configuredModels = new Set(Object.keys(models));
        const modelOptions = discoveredModels.filter(
          (model) => !configuredModels.has(model.value)
        );
        const modelDraft = modelDrafts[harnessId] ?? "";

        return (
          <section
            key={harnessId}
            className="space-y-3 rounded border border-panel-border bg-editor-bg p-3"
            aria-labelledby={`model-pricing-${harnessId}-heading`}
          >
            <div className="flex items-center justify-between gap-2">
              <h4
                id={`model-pricing-${harnessId}-heading`}
                className="text-sm font-medium text-foreground"
              >
                {HARNESS_INFO[harnessId].name}
              </h4>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => removeHarness(harnessId)}
                aria-label={`Remove ${HARNESS_INFO[harnessId].name} pricing overrides`}
              >
                <Icon name="trash" />
                <span className="sr-only">Remove harness</span>
              </Button>
            </div>

            <div className="space-y-2 border-b border-panel-border pb-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-description-fg">
                Add model
              </div>
              {modelOptions.length > 0 && (
                <CustomSelect
                  value={modelDraft}
                  onChange={(next) =>
                    setModelDrafts((drafts) => ({
                      ...drafts,
                      [harnessId]: next,
                    }))
                  }
                  options={modelOptions}
                  triggerAriaLabel={`Choose a discovered model for ${HARNESS_INFO[harnessId].name}`}
                />
              )}
              <div className="flex items-end gap-2">
                <LocalTextInput
                  aria-label={`Model ID for ${HARNESS_INFO[harnessId].name}`}
                  value={modelDraft}
                  onCommit={(next) =>
                    setModelDrafts((drafts) => ({
                      ...drafts,
                      [harnessId]: next,
                    }))
                  }
                  placeholder="Enter model ID"
                  className="min-w-0 flex-1 bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => addModel(harnessId)}
                  disabled={
                    !modelDraft.trim() ||
                    configuredModels.has(modelDraft.trim())
                  }
                >
                  Add model
                </Button>
              </div>
            </div>

            {UNKNOWN_TOKEN_SEMANTICS_HARNESSES.has(harnessId) &&
              Object.keys(models).length > 0 && (
                <p
                  className="flex items-start gap-1 text-xs text-warning-fg"
                  role="note"
                >
                  <Icon name="warning" className="mt-px" />
                  <span>
                    Cost estimates remain unavailable for this harness until its
                    token semantics are verified, even when these rates are
                    overridden.
                  </span>
                </p>
              )}

            {Object.entries(models).map(([modelId, override]) => (
              <div
                key={modelId}
                className="space-y-2 rounded border border-panel-border p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <code
                    className="min-w-0 truncate text-xs text-foreground"
                    title={modelId}
                  >
                    {modelId}
                  </code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => removeModel(harnessId, modelId)}
                    aria-label={`Remove model ${modelId}`}
                  >
                    <Icon name="trash" />
                    <span className="sr-only">Remove model</span>
                  </Button>
                </div>
                {override.inputPerMTok === 0 &&
                  override.outputPerMTok === 0 && (
                    <p
                      className="flex items-start gap-1 text-xs text-warning-fg"
                      role="note"
                    >
                      <Icon name="warning" className="mt-px" />
                      <span>
                        Both required rates are 0, so this override prices the
                        model at $0 instead of using the bundled price registry.
                        Enter real rates, or remove the model.
                      </span>
                    </p>
                  )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {RATE_FIELDS.map(({ key, label, optional }) => {
                    const id = inputId(harnessId, modelId, key);
                    const rate = override[key];
                    return (
                      <label
                        key={key}
                        htmlFor={id}
                        className="text-xs text-description-fg"
                      >
                        <span className="mb-1 block">
                          {label} USD / MTok{optional ? " (optional)" : ""}
                        </span>
                        <LocalNumberInput
                          id={id}
                          aria-label={`${label} rate for ${modelId}`}
                          min={0}
                          step="any"
                          value={rate}
                          allowEmpty={optional}
                          onCommit={(next) =>
                            updateRate(harnessId, modelId, key, next)
                          }
                          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
};
