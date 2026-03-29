/**
 * End condition utility functions
 *
 * These utilities handle the three-state logic for end conditions:
 * - undefined: Inherit from workflow (checkbox unchecked)
 * - null: Explicitly disabled (checkbox checked, fields empty)
 * - object: Custom end condition (checkbox checked, fields filled)
 */

import type { EndCondition, EndConditionCompareSource } from "./prompt";
export type { EndConditionCompareSource };

/** Property keys for end condition objects */
export const END_CONDITION_PROPERTIES = {
  SCRIPT: "script",
  RETURNS: "returns",
  COMPARE_SOURCE: "compareSource",
  TIMEOUT: "timeout",
  MAX_RETRIES: "maxRetries",
  RETRY_PROMPT: "retryPrompt",
  RESUME_SESSION_ON_RETRY: "resumeSessionOnRetry",
} as const;

/** Display labels for compareSource options */
export const COMPARE_SOURCE_LABELS: Record<EndConditionCompareSource, string> = {
  auto: "Auto",
  stdout: "Stdout",
  stderr: "Stderr",
  exitCode: "Exit Code",
};

/** Default values for end condition properties */
export interface EndConditionDefaults {
  END_SCRIPT: string;
  END_RETURNS: string;
  END_TIMEOUT: number;
  END_TIMEOUT_STRING: string;
  END_RETRIES: number;
  END_RETRIES_STRING: string;
  END_RETRY_PROMPT: string;
}

/** Standard default values */
export const DEFAULT_END_CONDITION_VALUES: EndConditionDefaults = {
  END_SCRIPT: "",
  END_RETURNS: "true",
  END_TIMEOUT: 30000,
  END_TIMEOUT_STRING: "30000",
  END_RETRIES: 0,
  END_RETRIES_STRING: "0",
  END_RETRY_PROMPT: "",
};

/**
 * Get end condition value from object with fallback to default
 *
 * @param endCondition - End condition object or null/undefined
 * @param property - Property name to get
 * @param defaultValue - Default value if property not found
 * @returns Property value or default
 *
 * @example
 * getEndConditionValue({ script: "npm test" }, "script", "") // "npm test"
 * getEndConditionValue(null, "script", "") // ""
 * getEndConditionValue({ timeout: 5000 }, "maxRetries", 0) // 0
 */
export function getEndConditionValue<T>(
  endCondition: EndCondition | null | undefined,
  property: string,
  defaultValue: T
): T {
  if (
    endCondition &&
    typeof endCondition === "object" &&
    property in endCondition
  ) {
    return (endCondition as unknown as Record<string, unknown>)[property] as T;
  }
  return defaultValue;
}

/**
 * Form field values for end condition editing
 */
export interface EndConditionFormValues {
  enabled: boolean;
  script: string;
  returns: string;
  timeout: string;
  maxRetries: string;
  retryPrompt: string;
}

/**
 * Build end condition object from form values
 *
 * Logic:
 * - enabled=false: Returns undefined (inherit from workflow)
 * - enabled=true + empty required fields: Returns null (explicitly disable)
 * - enabled=true + filled fields: Returns end condition object (override)
 *
 * @param formValues - Current form field values
 * @param defaults - Default values for comparison
 * @returns End condition object, null, or undefined
 *
 * @example
 * // Inherit from workflow
 * buildEndConditionFromValues({ enabled: false, ... }, defaults) // undefined
 *
 * // Explicitly disable
 * buildEndConditionFromValues({ enabled: true, script: "", ... }, defaults) // null
 *
 * // Custom end condition
 * buildEndConditionFromValues({
 *   enabled: true,
 *   script: "npm test",
 *   returns: "true",
 *   ...
 * }, defaults) // { script: "npm test", returns: "true", ... }
 */
export function buildEndConditionFromValues(
  formValues: EndConditionFormValues,
  defaults: EndConditionDefaults = DEFAULT_END_CONDITION_VALUES
): EndCondition | null | undefined {
  // If checkbox is unchecked, return undefined to inherit from workflow
  if (!formValues.enabled) {
    return undefined;
  }

  // Checkbox is checked - check if required fields are filled
  const script = formValues.script.trim();
  const returns = formValues.returns.trim();
  const retryPrompt = formValues.retryPrompt.trim();
  const timeout = parseInt(formValues.timeout, 10);
  const maxRetries = parseInt(formValues.maxRetries, 10);

  // If checked but required fields are empty, return null to explicitly disable
  if (!script || !returns) {
    return null;
  }

  // Build end condition with required fields
  const endCondition: EndCondition = {
    script,
    returns,
  };

  // Add optional fields only if they differ from defaults
  if (!isNaN(timeout) && timeout !== defaults.END_TIMEOUT) {
    endCondition.timeout = timeout;
  }
  if (!isNaN(maxRetries) && maxRetries !== defaults.END_RETRIES) {
    endCondition.maxRetries = maxRetries;
  }
  if (retryPrompt) {
    endCondition.retryPrompt = retryPrompt;
  }

  return endCondition;
}

/**
 * Convert end condition to form values for editing
 *
 * Logic:
 * - undefined: enabled=false, fields at defaults (inherit from workflow)
 * - null: enabled=true, fields empty (explicitly disabled)
 * - object: enabled=true, fields from object (custom override)
 *
 * @param endCondition - End condition object, null, or undefined
 * @param defaults - Default values to use
 * @returns Form values for rendering
 */
export function endConditionToFormValues(
  endCondition: EndCondition | null | undefined,
  defaults: EndConditionDefaults = DEFAULT_END_CONDITION_VALUES
): EndConditionFormValues {
  if (endCondition === undefined) {
    // Undefined: Inherit from workflow (unchecked, defaults)
    return {
      enabled: false,
      script: defaults.END_SCRIPT,
      returns: defaults.END_RETURNS,
      timeout: defaults.END_TIMEOUT_STRING,
      maxRetries: defaults.END_RETRIES_STRING,
      retryPrompt: defaults.END_RETRY_PROMPT,
    };
  }

  if (endCondition === null) {
    // Null: Explicitly disabled (checked, empty)
    return {
      enabled: true,
      script: "",
      returns: "",
      timeout: defaults.END_TIMEOUT_STRING,
      maxRetries: defaults.END_RETRIES_STRING,
      retryPrompt: "",
    };
  }

  // Object: Custom override (checked, filled)
  return {
    enabled: true,
    script: getEndConditionValue(
      endCondition,
      END_CONDITION_PROPERTIES.SCRIPT,
      defaults.END_SCRIPT
    ),
    returns: getEndConditionValue(
      endCondition,
      END_CONDITION_PROPERTIES.RETURNS,
      defaults.END_RETURNS
    ),
    timeout: String(
      getEndConditionValue(
        endCondition,
        END_CONDITION_PROPERTIES.TIMEOUT,
        defaults.END_TIMEOUT
      )
    ),
    maxRetries: String(
      getEndConditionValue(
        endCondition,
        END_CONDITION_PROPERTIES.MAX_RETRIES,
        defaults.END_RETRIES
      )
    ),
    retryPrompt: getEndConditionValue(
      endCondition,
      END_CONDITION_PROPERTIES.RETRY_PROMPT,
      defaults.END_RETRY_PROMPT
    ),
  };
}

/**
 * Check if end condition has any meaningful configuration
 *
 * @param endCondition - End condition to check
 * @returns true if end condition is defined and has script
 */
export function hasEndCondition(
  endCondition: EndCondition | null | undefined
): boolean {
  return (
    endCondition !== null &&
    endCondition !== undefined &&
    Boolean(endCondition.script)
  );
}
