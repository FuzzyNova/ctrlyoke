/**
 * FlightPath Dashboard Utilities Module
 *
 * Pure utility functions with no side effects.
 * These functions can be used across all dashboard modules.
 *
 * Exports:
 * - Time utilities: getTimestamp, formatTime, formatRelativeTime
 * - String utilities: escapeHtml, truncate, getWorkflowName
 * - End condition utilities: getEndConditionValue, buildEndConditionFromControls, setEndConditionControls
 * - Prompt item factory: createPromptItem
 * - DOM utilities: getStatusIcon
 */
(function () {
  // Import constants from global scope (loaded via script tag in HTML)
  const { STEP_STATUS, PROMPT_PROPERTIES, END_CONDITION_PROPERTIES } =
    window.FlightPathConstants;

  /**
   * Get current timestamp in milliseconds
   */
  function getTimestamp() {
    return new Date().getTime();
  }

  /**
   * Format timestamp as locale time string
   */
  function formatTime(timestampMs) {
    return new Date(timestampMs).toLocaleTimeString();
  }

  /**
   * Format timestamp as relative time ago
   * Examples: "1 min", "43 min", "2 hr", "5 days"
   * @param {number} timestampMs - Timestamp in milliseconds
   * @returns {string} Relative time string
   */
  function formatRelativeTime(timestampMs) {
    const now = Date.now();
    const diffMs = now - timestampMs;

    // Calculate time units
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    // Format based on largest unit
    if (days > 0) {
      return `${days} day${days !== 1 ? "s" : ""}`;
    } else if (hours > 0) {
      return `${hours} hr`;
    } else if (minutes > 0) {
      return `${minutes} min`;
    } else {
      return "just now";
    }
  }

  /**
   * Escape HTML special characters
   */
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Truncate string to maximum length
   */
  function truncate(str, maxLen) {
    return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
  }

  /**
   * Get workflow name from file path
   * @param {string} filePath - Full file path
   * @returns {string} Workflow name without extension or "New Workflow"
   */
  function getWorkflowName(filePath) {
    if (!filePath) return "New Workflow";
    const fileName = filePath.split(/[/\\]/).pop(); // Get last segment
    return fileName.replace(/\.(flightpath\.(json|yaml|yml)|prompt\.md)$/, ""); // Remove extension
  }

  /**
   * Get end condition value from object with fallback to default
   * @param {Object} endCondition - End condition object
   * @param {string} property - Property name from END_CONDITION_PROPERTIES
   * @param {any} defaultValue - Default value if not found
   */
  function getEndConditionValue(endCondition, property, defaultValue) {
    return endCondition && endCondition[property] !== undefined
      ? endCondition[property]
      : defaultValue;
  }

  /**
   * Build end condition object from current property control values
   *
   * Logic:
   * - Checkbox UNCHECKED: Returns undefined (inherit from workflow)
   * - Checkbox CHECKED + empty fields: Returns null (explicitly disable workflow end condition)
   * - Checkbox CHECKED + filled fields: Returns end condition object (override workflow)
   *
   * @param {Object} elements - DOM elements object
   * @param {Object} propertyDefaults - Default values for properties
   * @returns {Object|null|undefined} End condition object, null (explicit disable), or undefined (inherit)
   */
  function buildEndConditionFromControls(elements, propertyDefaults) {
    const isEnabled =
      elements.propEndEnabled && elements.propEndEnabled.checked;

    // If checkbox is unchecked, return undefined to inherit from workflow
    if (!isEnabled) {
      return undefined;
    }

    // Checkbox is checked - check if fields are filled
    const script = elements.propEndScript.value.trim();
    const returns = elements.propEndReturns.value.trim();
    const retryPrompt = elements.propEndRetryPrompt.value.trim();
    const timeout = parseInt(elements.propEndTimeout.value, 10);
    const maxRetries = parseInt(elements.propEndRetries.value, 10);

    // If checked but required fields are empty, return null to explicitly disable
    if (!script || !returns) {
      return null;
    }

    // Build end condition with required fields and optional fields
    const endCondition = {
      [END_CONDITION_PROPERTIES.SCRIPT]: script,
      [END_CONDITION_PROPERTIES.RETURNS]: returns,
    };

    // Add optional fields only if they differ from defaults
    if (!isNaN(timeout) && timeout !== propertyDefaults.END_TIMEOUT) {
      endCondition[END_CONDITION_PROPERTIES.TIMEOUT] = timeout;
    }
    if (!isNaN(maxRetries) && maxRetries !== propertyDefaults.END_RETRIES) {
      endCondition[END_CONDITION_PROPERTIES.MAX_RETRIES] = maxRetries;
    }
    if (retryPrompt) {
      endCondition[END_CONDITION_PROPERTIES.RETRY_PROMPT] = retryPrompt;
    }

    return endCondition;
  }

  /**
   * Set end condition controls from end condition object
   *
   * Logic:
   * - endCondition is object: Check checkbox, fill fields (override workflow)
   * - endCondition is null: Check checkbox, clear fields (explicitly disable)
   * - endCondition is undefined: Uncheck checkbox (inherit from workflow)
   *
   * @param {Object} elements - DOM elements object
   * @param {Object} propertyDefaults - Default values for properties
   * @param {Object|null|undefined} endCondition - End condition object, null, or undefined
   */
  function setEndConditionControls(elements, propertyDefaults, endCondition) {
    // Get the collapsible details element (for dashboard properties drawer)
    const propEndDetails = document.getElementById("prop-end-details");

    // Handle checkbox state
    if (elements.propEndEnabled) {
      if (endCondition === undefined) {
        // Undefined: Uncheck checkbox (inherit from workflow)
        elements.propEndEnabled.checked = false;
        // Collapse the section
        if (propEndDetails) {
          propEndDetails.classList.add("collapsed");
        }
        // Disable all fields
        elements.propEndScript.disabled = true;
        elements.propEndReturns.disabled = true;
        elements.propEndTimeout.disabled = true;
        elements.propEndRetries.disabled = true;
        elements.propEndRetryPrompt.disabled = true;
        // Reset to defaults
        elements.propEndScript.value = propertyDefaults.END_SCRIPT;
        elements.propEndReturns.value = propertyDefaults.END_RETURNS;
        elements.propEndTimeout.value = propertyDefaults.END_TIMEOUT_STRING;
        elements.propEndRetries.value = propertyDefaults.END_RETRIES_STRING;
        elements.propEndRetryPrompt.value = propertyDefaults.END_RETRY_PROMPT;
      } else if (endCondition === null) {
        // Null: Check checkbox but clear fields (explicitly disable)
        elements.propEndEnabled.checked = true;
        // Expand the section
        if (propEndDetails) {
          propEndDetails.classList.remove("collapsed");
        }
        // Enable all fields
        elements.propEndScript.disabled = false;
        elements.propEndReturns.disabled = false;
        elements.propEndTimeout.disabled = false;
        elements.propEndRetries.disabled = false;
        elements.propEndRetryPrompt.disabled = false;
        // Clear fields to show explicit disable
        elements.propEndScript.value = "";
        elements.propEndReturns.value = "";
        elements.propEndTimeout.value = propertyDefaults.END_TIMEOUT_STRING;
        elements.propEndRetries.value = propertyDefaults.END_RETRIES_STRING;
        elements.propEndRetryPrompt.value = "";
      } else {
        // Object: Check checkbox and fill fields (override workflow)
        elements.propEndEnabled.checked = true;
        // Expand the section
        if (propEndDetails) {
          propEndDetails.classList.remove("collapsed");
        }
        // Enable all fields
        elements.propEndScript.disabled = false;
        elements.propEndReturns.disabled = false;
        elements.propEndTimeout.disabled = false;
        elements.propEndRetries.disabled = false;
        elements.propEndRetryPrompt.disabled = false;
        // Fill fields
        elements.propEndScript.value = getEndConditionValue(
          endCondition,
          END_CONDITION_PROPERTIES.SCRIPT,
          propertyDefaults.END_SCRIPT
        );
        elements.propEndReturns.value = getEndConditionValue(
          endCondition,
          END_CONDITION_PROPERTIES.RETURNS,
          propertyDefaults.END_RETURNS
        );
        elements.propEndTimeout.value = getEndConditionValue(
          endCondition,
          END_CONDITION_PROPERTIES.TIMEOUT,
          propertyDefaults.END_TIMEOUT
        );
        elements.propEndRetries.value = getEndConditionValue(
          endCondition,
          END_CONDITION_PROPERTIES.MAX_RETRIES,
          propertyDefaults.END_RETRIES
        );
        elements.propEndRetryPrompt.value = getEndConditionValue(
          endCondition,
          END_CONDITION_PROPERTIES.RETRY_PROMPT,
          propertyDefaults.END_RETRY_PROMPT
        );
      }
    }
  }

  /**
   * Create a prompt item with all properties preserved (DRY helper)
   * Used by handleFileSelected, handleSessionRestored, and handlePromptsExtended
   * @param {Object|string} prompt - Raw prompt object or string
   * @param {number} index - Prompt index in array
   * @param {string} status - Step status (pending, running, completed, failed)
   * @param {Object} details - Additional details object
   * @returns {Object} Prompt item with all properties
   */
  function createPromptItem(
    prompt,
    index,
    status = STEP_STATUS.PENDING,
    details = {}
  ) {
    return {
      index,
      text:
        typeof prompt === "string" ? prompt : prompt[PROMPT_PROPERTIES.PROMPT],
      status,
      details,
      // Preserve all prompt properties for editing using shared constants
      [PROMPT_PROPERTIES.PROVIDER]: prompt[PROMPT_PROPERTIES.PROVIDER],
      [PROMPT_PROPERTIES.MODEL]: prompt[PROMPT_PROPERTIES.MODEL],
      [PROMPT_PROPERTIES.AGENT]: prompt[PROMPT_PROPERTIES.AGENT],
      [PROMPT_PROPERTIES.RESUME_SESSION]:
        prompt[PROMPT_PROPERTIES.RESUME_SESSION],
      [PROMPT_PROPERTIES.SESSION_ID]: prompt[PROMPT_PROPERTIES.SESSION_ID],
      [PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION]:
        prompt[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION],
      [PROMPT_PROPERTIES.END_CONDITION]:
        prompt[PROMPT_PROPERTIES.END_CONDITION],
    };
  }

  /**
   * Get status icon HTML for a given status
   * @param {string} status - Step status
   * @returns {string} HTML string with codicon
   */
  function getStatusIcon(status) {
    // Use codicons for proper VS Code theme integration
    const icons = {
      [STEP_STATUS.PENDING]: '<i class="codicon codicon-circle-outline"></i>',
      [STEP_STATUS.RUNNING]: '<i class="codicon codicon-play"></i>',
      [STEP_STATUS.COMPLETED]: '<i class="codicon codicon-pass"></i>',
      [STEP_STATUS.FAILED]: '<i class="codicon codicon-error"></i>',
    };
    return icons[status] || icons[STEP_STATUS.PENDING];
  }

  // Export public API to global scope
  window.FlightPathUtilities = {
    getTimestamp,
    formatTime,
    formatRelativeTime,
    escapeHtml,
    truncate,
    getWorkflowName,
    getEndConditionValue,
    buildEndConditionFromControls,
    setEndConditionControls,
    createPromptItem,
    getStatusIcon,
  };
})();
