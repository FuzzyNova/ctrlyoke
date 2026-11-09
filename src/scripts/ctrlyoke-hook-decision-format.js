/**
 * Harness-native decision format facts shared by decision hook wrappers.
 * Keep this module as the Phase 2 normalizer's home (see
 * dev/backlog/HOOK_DECISION_FORMAT_PLAN.md).
 */

// Exit 0 with empty stdout leaves the decision to the normal permission flow.
// Claude, Copilot and Qwen treat exit 2 as blocking; Copilot also fails open
// on timeout, while its other nonzero exits fail closed. Antigravity has no
// permissionRequest hook; OpenCode's plugin has no reply channel.
const NO_DECISION_EXIT_CODES = Object.freeze({
  "claude-cli": 0,
  "copilot-cli": 0,
  "codex-cli": 0,
  "qwen-cli": 0,
  "antigravity-cli": 0,
  "opencode-cli": 0,
});

function noDecisionExitCode(harnessId) {
  return NO_DECISION_EXIT_CODES[harnessId] ?? 0;
}

module.exports = { NO_DECISION_EXIT_CODES, noDecisionExitCode };
