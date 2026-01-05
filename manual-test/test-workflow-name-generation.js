/**
 * Manual test to verify workflow name generation from prompts
 * Run: node manual-test/test-workflow-name-generation.js
 */

function generateWorkflowNameFromPrompt(text) {
  // Extract first 5 words (or fewer if prompt is shorter)
  const words = text
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .map((word) =>
      word
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with dashes
        .replace(/^-+|-+$/g, "") // Remove leading/trailing dashes
    )
    .filter((word) => word.length > 0);

  // If no valid words, use "ephemeral-prompt"
  const baseName = words.length > 0 ? words.join("-") : "ephemeral-prompt";

  // Add timestamp for uniqueness
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, ""); // HHMMSS

  return `${baseName}-${dateStr}-${timeStr}.flightpath.json`;
}

// Test cases
const testPrompts = [
  "review code and implement feature according to this plan",
  "Fix all TypeScript errors in the project",
  "Analyze the FlightPath extension architecture and suggest improvements",
  "Help me understand how the dashboard works",
  "Debug",
  "   ",  // Empty prompt
  "@workspace /explain #file:src/extension.ts",
  "Review code & implement feature!!! (with #special-chars)",
];

console.log("Workflow Name Generation Test\n" + "=".repeat(60) + "\n");

testPrompts.forEach((prompt) => {
  const name = generateWorkflowNameFromPrompt(prompt);
  console.log(`Prompt: ${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}`);
  console.log(`Name:   ${name}`);
  console.log("");
});
