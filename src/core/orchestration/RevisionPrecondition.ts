export function assertDefinitionRevision(
  expected: number,
  actual: number | undefined
): void {
  const normalizedActual = actual ?? 1;
  if (expected !== normalizedActual) {
    throw new Error(
      `Definition revision conflict: expected ${expected}, found ${normalizedActual}`
    );
  }
}

export function assertDescriptorRevision(
  expected: number,
  actual: number
): void {
  if (expected !== actual) {
    throw new Error(
      `Descriptor revision conflict: expected ${expected}, found ${actual}`
    );
  }
}
