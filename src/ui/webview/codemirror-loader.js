/**
 * CodeMirror Module Loader (Bundled Version)
 * Imports bundled CodeMirror and exposes as window.CM
 */

(async function () {
  console.log("[CodeMirror] Loading bundled modules...");

  try {
    // Import the bundled CodeMirror module
    const CM = await import("./lib/codemirror.bundle.js");

    // Expose to global scope for CodeMirrorPromptEditor
    window.CM = CM;

    console.log("[CodeMirror] Bundle loaded successfully");

    // Dispatch event for editor initialization
    window.dispatchEvent(new Event("codemirror-ready"));
  } catch (error) {
    console.error("[CodeMirror] Failed to load bundle:", error);

    // Fallback: show error message
    window.CM = null;
    window.dispatchEvent(new Event("codemirror-error"));
  }
})();
