/**
 * String utility functions
 */
import { DEFAULT_WORKFLOW_NAME } from "@root/types/DashboardConstants";

/**
 * Escape HTML special characters to prevent XSS
 * Uses DOM-based escaping for correctness
 *
 * @param text - Raw text to escape
 * @returns HTML-safe escaped string
 *
 * @example
 * escapeHtml('<script>alert("xss")</script>')
 * // '&lt;script&gt;alert("xss")&lt;/script&gt;'
 */
export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Truncate string to maximum length with ellipsis
 *
 * @param str - String to truncate
 * @param maxLen - Maximum length including ellipsis
 * @returns Truncated string with "..." if exceeded
 *
 * @example
 * truncate("Hello World", 8) // "Hello..."
 * truncate("Hi", 10) // "Hi"
 */
export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
}

export function truncateSnippet(snippet: string, maxLength = 80): string {
  const normalized = snippet.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

/**
 * Get workflow name from file path
 * Extracts filename and removes ctrlyoke-specific extensions
 *
 * @param filePath - Full file path or null/undefined
 * @returns Workflow name without extension, or DEFAULT_WORKFLOW_NAME if no path
 *
 * @example
 * getWorkflowName("/path/to/my-workflow.ctrlyoke.yaml") // "my-workflow"
 * getWorkflowName("C:\\Users\\dev\\feature.ctrlyoke.json") // "feature"
 * getWorkflowName("/path/prompt.prompt.md") // "prompt"
 * getWorkflowName(null) // DEFAULT_WORKFLOW_NAME
 */
export function getWorkflowName(filePath: string | null | undefined): string {
  if (!filePath) return DEFAULT_WORKFLOW_NAME;

  // Get last segment (handles both / and \ separators)
  const fileName = filePath.split(/[/\\]/).pop() || "";

  // Remove ctrlyoke extensions: .ctrlyoke.json, .ctrlyoke.yaml, .ctrlyoke.yml, .prompt.md
  return fileName.replace(/\.(ctrlyoke\.(json|yaml|yml)|prompt\.md)$/, "");
}

/**
 * Capitalize first letter of a string
 *
 * @param str - String to capitalize
 * @returns String with first letter capitalized
 */
export function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert kebab-case or snake_case to Title Case
 *
 * @param str - String in kebab-case or snake_case
 * @returns Title Case string
 *
 * @example
 * toTitleCase("copilot-cli") // "Copilot Cli"
 * toTitleCase("claude_code") // "Claude Code"
 */
export function toTitleCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((word) => capitalize(word))
    .join(" ");
}

/**
 * Validate a name intended for use as a filename (workflow name, template
 * name) — same "safe filename" rule enforced on the extension side by
 * `TemplateManager.validateTemplateName`.
 *
 * @param name - Candidate name
 * @param requiredMessage - Error text when the name is empty
 * @returns Error message, or null if valid
 */
export function validateSafeName(
  name: string,
  requiredMessage = "Name is required"
): string | null {
  if (!name.trim()) {
    return requiredMessage;
  }
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    return "Invalid characters in name";
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) {
    return "Reserved filename";
  }
  return null;
}

/**
 * Generate a unique ID string.
 *
 * Prefers `crypto.randomUUID()` when available (modern browsers).
 * Falls back to `crypto.getRandomValues()` for iOS Safari < 15.4 and other
 * older browsers that support the Web Crypto API but not randomUUID().
 */
export function generateId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // Fallback: build a UUID-shaped string from getRandomValues (iOS Safari 3.1+)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Set version 4 and variant bits per RFC 4122
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
