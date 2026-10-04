export const STEP_MUTATION_PROMPT_FIELD = "prompt" as const;

export function parseIndex(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

export function displayIndex(index: number): string {
  return `#${index + 1}`;
}
