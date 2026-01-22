/**
 * Diff library bundle for webview
 * Exposes window.Diff for use in output-manager.js
 */
import * as Diff from 'diff';

// Expose to global window object
window.Diff = Diff;
