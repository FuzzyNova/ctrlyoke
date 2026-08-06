export function formatMultiFilterLabel(
  selectedValues: string[],
  allValues: string[],
  pluralLabel: string,
  options: Array<{ value: string; label: string }>
): string {
  if (selectedValues.length === allValues.length) {
    return `All ${pluralLabel}`;
  }

  if (selectedValues.length === 1) {
    return (
      options.find((option) => option.value === selectedValues[0])?.label ??
      selectedValues[0]
    );
  }

  return `${selectedValues.length} ${pluralLabel}`;
}
