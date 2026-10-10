import * as yaml from "js-yaml";

/** Shared schema for workflow YAML, including YAML 1.1 merge keys. */
export const WORKFLOW_YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.mergeTag);

/**
 * Load a YAML document while treating empty and comment-only input as null.
 * js-yaml 5 throws for those inputs, though callers generally handle them as
 * an absent document and apply their own domain-specific validation.
 */
export function loadYamlDocument<T = unknown>(
  text: string,
  options?: yaml.LoadOptions
): T | null {
  try {
    return yaml.load(text, options) as T | null;
  } catch (error) {
    if (
      error instanceof yaml.YAMLException &&
      error.reason === "expected a document, but the input is empty"
    ) {
      return null;
    }
    throw error;
  }
}
