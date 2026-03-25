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

/**
 * Get workflow name from file path
 * Extracts filename and removes FlightPath-specific extensions
 *
 * @param filePath - Full file path or null/undefined
 * @returns Workflow name without extension, or DEFAULT_WORKFLOW_NAME if no path
 *
 * @example
 * getWorkflowName("/path/to/my-workflow.flightpath.yaml") // "my-workflow"
 * getWorkflowName("C:\\Users\\dev\\feature.flightpath.json") // "feature"
 * getWorkflowName("/path/prompt.prompt.md") // "prompt"
 * getWorkflowName(null) // DEFAULT_WORKFLOW_NAME
 */
export function getWorkflowName(filePath: string | null | undefined): string {
  if (!filePath) return DEFAULT_WORKFLOW_NAME;

  // Get last segment (handles both / and \ separators)
  const fileName = filePath.split(/[/\\]/).pop() || "";

  // Remove FlightPath extensions: .flightpath.json, .flightpath.yaml, .flightpath.yml, .prompt.md
  return fileName.replace(/\.(flightpath\.(json|yaml|yml)|prompt\.md)$/, "");
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
