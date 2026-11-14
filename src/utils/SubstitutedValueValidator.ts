type ValueValidator = (pointer: string, value: unknown) => boolean;

let validator: ValueValidator | undefined;

/** The parser installs its schema-backed validator on the shared Ajv instance. */
export function setSubstitutedValueValidator(value: ValueValidator): void {
  validator = value;
}

export function validateSubstitutedValue(
  pointer: string,
  value: unknown
): boolean {
  return validator?.(pointer, value) ?? false;
}
