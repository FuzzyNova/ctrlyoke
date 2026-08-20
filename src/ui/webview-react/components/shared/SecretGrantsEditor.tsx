import { useMemo } from "react";
import { FieldDiagnostic } from "./FieldDiagnostic";
import { MultiCheckboxDropdown } from "./MultiCheckboxDropdown";
import {
  filterExplicitSecretGrants,
  useSecretGrantOptions,
} from "./useSecretGrantOptions";

export interface SecretGrantsEditorProps {
  value: string[] | null | undefined;
  inheritedValue: readonly string[];
  onChange: (value: string[]) => void;
  inlineSecretNames?: readonly string[];
  idPrefix?: string;
  title?: string;
}

/** Shared secret-grant control for prompt and script step surfaces. */
export function SecretGrantsEditor({
  value,
  inheritedValue,
  onChange,
  inlineSecretNames = [],
  idPrefix = "secrets",
  title = "Grant named credentials to this step.",
}: SecretGrantsEditorProps) {
  const resolvedSecrets = useMemo(
    () => (value !== undefined ? (value ?? []) : [...inheritedValue]),
    [inheritedValue, value]
  );
  const inlineNames = useMemo(
    () => [...inlineSecretNames],
    [inlineSecretNames]
  );
  const {
    options,
    selectedValues,
    lockedValues,
    nonHideableValues,
    unresolvedSecretDiagnostics,
    warning,
  } = useSecretGrantOptions({
    declaredSecrets: resolvedSecrets,
    inlineSecretNames: inlineNames,
  });

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={`${idPrefix}-control`}
        className="text-xs font-semibold uppercase text-description-fg"
        title={title}
      >
        Secrets
      </label>
      <MultiCheckboxDropdown
        id={`${idPrefix}-control`}
        selectedValues={selectedValues}
        onChange={(nextValues) =>
          onChange(filterExplicitSecretGrants(nextValues, inlineNames))
        }
        options={options}
        buttonLabel={
          value === undefined
            ? `Inherit (${resolvedSecrets.length === 0 ? "None" : resolvedSecrets.join(", ")})`
            : value === null
              ? "None"
              : undefined
        }
        placeholder="No secrets granted"
        lockedValues={lockedValues}
        nonHideableValues={nonHideableValues}
        warning={warning}
      />
      {selectedValues.length > 0 && (
        <p className="mt-0.5 text-xxs text-description-fg">
          Active: {selectedValues.join(", ")}
        </p>
      )}
      <FieldDiagnostic
        id={`${idPrefix}-diagnostic`}
        diagnostics={unresolvedSecretDiagnostics}
      />
    </div>
  );
}
