import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import {
  AUTO_DETECT_HARNESS,
  HARNESS_DISPLAY_ORDER,
  HARNESS_INFO,
  INHERIT_DEFAULT_OPTION,
  pickFirstAvailableHarness,
  type HarnessId,
} from "@root/types/DashboardConstants";
import { useEffect, useState } from "react";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import {
  CustomSelect,
  HarnessDropdown,
  LocalAdditionalArgsEditor,
} from "@components/shared";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { LocalTextInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { getHarnessStepColorPickerValue } from "@utils/stepColor";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const EMPTY_HIDDEN_VALUES: string[] = [];

export function HarnessesSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const models = settings.settings.defaults.models;
  const additionalArgs = settings.settings.defaults.additionalArgs;
  const harnessColors = settings.settings.ui.harnessColors;
  const sources = settings.sources as Record<string, SettingSource>;
  const getModelsForHarness = useSettingsStore((s) => s.getModelsForHarness);
  const harnessStatus = useSettingsStore((s) => s.harnessStatus);
  const detectedHarness = pickFirstAvailableHarness(
    (harnessId) => harnessStatus[harnessId]?.available === true
  );
  const hiddenDropdownOptions = useUiStore((s) => s.hiddenDropdownOptions);
  const hideHarness = useUiStore((s) => s.hideDropdownOption);
  const unhideHarness = useUiStore((s) => s.unhideDropdownOption);
  const rowProps = { sources, onReset, activeScope };
  const [localHarnessColors, setLocalHarnessColors] = useState<
    Record<HarnessId, string>
  >(
    () =>
      Object.fromEntries(
        HARNESS_DISPLAY_ORDER.map((harnessId) => [
          harnessId,
          harnessColors.byHarness[harnessId] ??
            getHarnessStepColorPickerValue(harnessId),
        ])
      ) as Record<HarnessId, string>
  );

  useEffect(() => {
    setLocalHarnessColors(
      Object.fromEntries(
        HARNESS_DISPLAY_ORDER.map((harnessId) => [
          harnessId,
          harnessColors.byHarness[harnessId] ??
            getHarnessStepColorPickerValue(harnessId),
        ])
      ) as Record<HarnessId, string>
    );
  }, [harnessColors]);
  const hiddenHarnesses =
    hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? EMPTY_HIDDEN_VALUES;
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Harness Defaults
      </h3>
      <SettingInputRow
        settingKey="defaults.harness"
        id="harness-active"
        {...rowProps}
      >
        <HarnessDropdown
          id="harness-active"
          schemaPath="defaults.harness"
          value={settings.settings.defaults.harness || INHERIT_DEFAULT_OPTION}
          onChange={(value) =>
            onUpdate(
              "defaults.harness",
              value === INHERIT_DEFAULT_OPTION ? AUTO_DETECT_HARNESS : value
            )
          }
          showDefault={true}
          defaultLabel={
            detectedHarness
              ? `Auto-detect (${HARNESS_INFO[detectedHarness].name})`
              : "Auto-detect (first installed)"
          }
          showStatus={false}
          hiddenValues={hiddenHarnesses}
          onHideOption={(value) =>
            hideHarness(DROPDOWN_NAMESPACES.HARNESS, value)
          }
          onUnhideOption={(value) =>
            unhideHarness(DROPDOWN_NAMESPACES.HARNESS, value)
          }
          triggerAriaLabel="Choose active harness"
          triggerTitle="Choose the default active harness"
        />
      </SettingInputRow>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Model & Extra Args Defaults
        </h3>
      </div>
      <p className="text-xs text-description-fg -mt-2">
        Configure the default model and additional CLI args for each harness.
        These are used when no workflow-level override is set.
      </p>
      <div className="space-y-4">
        {HARNESS_DISPLAY_ORDER.map((harnessId) => {
          const info = HARNESS_INFO[harnessId as keyof typeof HARNESS_INFO];
          const currentModel =
            (models as Record<string, string | undefined>)[harnessId] ?? "";
          const discoveredModels = getModelsForHarness(harnessId);

          return (
            <div
              key={harnessId}
              className="border border-panel-border rounded p-3 space-y-2"
            >
              <div className="text-sm font-medium text-foreground">
                {info.name}
              </div>
              <SettingInputRow
                settingKey={`defaults.models.${harnessId}`}
                id={`model-${harnessId}`}
                {...rowProps}
              >
                {discoveredModels.length > 0 ? (
                  <CustomSelect
                    id={`model-${harnessId}`}
                    value={currentModel}
                    onChange={(v) =>
                      onUpdate(`defaults.models.${harnessId}`, v || undefined)
                    }
                    schemaPath={`defaults.models.${harnessId}`}
                    options={discoveredModels}
                  />
                ) : (
                  <LocalTextInput
                    id={`model-${harnessId}`}
                    value={currentModel}
                    onCommit={(v) =>
                      onUpdate(`defaults.models.${harnessId}`, v || undefined)
                    }
                    placeholder="Enter model ID"
                    className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                )}
              </SettingInputRow>
              <SettingInputRow
                settingKey={`defaults.additionalArgs.${harnessId}`}
                id={`extra-args-${harnessId}`}
                {...rowProps}
              >
                <LocalAdditionalArgsEditor
                  id={`extra-args-${harnessId}`}
                  harnessId={harnessId}
                  value={
                    (additionalArgs as Record<string, string | undefined>)[
                      harnessId
                    ] ?? ""
                  }
                  onCommit={(v) =>
                    onUpdate(
                      `defaults.additionalArgs.${harnessId}`,
                      v || undefined
                    )
                  }
                  className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                />
              </SettingInputRow>
              <SettingInputRow
                settingKey={`ui.harnessColors.byHarness.${harnessId}`}
                id={`step-color-${harnessId}`}
                {...rowProps}
              >
                <input
                  id={`step-color-${harnessId}`}
                  type="color"
                  value={
                    localHarnessColors[harnessId] ??
                    getHarnessStepColorPickerValue(harnessId)
                  }
                  onChange={(e) =>
                    setLocalHarnessColors((previous) => ({
                      ...previous,
                      [harnessId]: e.target.value,
                    }))
                  }
                  onBlur={(e) =>
                    onUpdate(
                      `ui.harnessColors.byHarness.${harnessId}`,
                      e.target.value
                    )
                  }
                  className="w-full h-8 cursor-pointer rounded border border-input-border p-0.5 bg-input-bg"
                  title={`${info.name} color`}
                />
              </SettingInputRow>
            </div>
          );
        })}
      </div>
    </div>
  );
}
