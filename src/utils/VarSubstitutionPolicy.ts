/** Phases in which workflow variable fields are resolved. */
export const VAR_SUBSTITUTION_PHASES = {
  RUN_START: "run-start",
  DISPATCH: "dispatch",
} as const;
export type VarSubstitutionPhase =
  (typeof VAR_SUBSTITUTION_PHASES)[keyof typeof VAR_SUBSTITUTION_PHASES];

export const VAR_SUBSTITUTION_KINDS = { TEXT: "text", VALUE: "value" } as const;
export type VarSubstitutionKind =
  (typeof VAR_SUBSTITUTION_KINDS)[keyof typeof VAR_SUBSTITUTION_KINDS];
export const VAR_SUBSTITUTION_UNRESOLVED = {
  ADVISORY: "advisory",
  ERROR: "error",
} as const;
export type VarSubstitutionUnresolved =
  (typeof VAR_SUBSTITUTION_UNRESOLVED)[keyof typeof VAR_SUBSTITUTION_UNRESOLVED];

export const VAR_SUBSTITUTION_POLICY = {
  "worktree.branch": {
    phase: VAR_SUBSTITUTION_PHASES.RUN_START,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "worktree.base": {
    phase: VAR_SUBSTITUTION_PHASES.RUN_START,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "worktree.directory": {
    phase: VAR_SUBSTITUTION_PHASES.RUN_START,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "defaults.worktree.branch": {
    phase: VAR_SUBSTITUTION_PHASES.RUN_START,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "defaults.worktree.base": {
    phase: VAR_SUBSTITUTION_PHASES.RUN_START,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "defaults.worktree.directory": {
    phase: VAR_SUBSTITUTION_PHASES.RUN_START,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  harness: { phase: VAR_SUBSTITUTION_PHASES.RUN_START, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].harness": { phase: VAR_SUBSTITUTION_PHASES.RUN_START, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].enabled": { phase: VAR_SUBSTITUTION_PHASES.RUN_START, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  maxSteps: { phase: VAR_SUBSTITUTION_PHASES.RUN_START, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "prompt.prompt": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: true,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "steps[].prompt": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: true,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "steps[].model": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "steps[].name": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "steps[].expected": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "steps[].shell": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "steps[].agent": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "steps[].skills[]": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "steps[].sessionId": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "steps[].priorContext.workflow": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "steps[].priorContext.run": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
  },
  "steps[].executionMode": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].resumeSession": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].priorContextDetail": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].timeoutSec": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].endCondition.maxRetries": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].compareSource": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].operator": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].ignoreCase": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].preCondition.onPass": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].preCondition.onFail": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].endCondition.onPass": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].endCondition.onFail": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].onPass": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].onFail": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].errorBehavior.onError": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].errorBehavior.maxRetries": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].errorBehavior.retryDelaySec": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].preCondition.timeoutSec": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].preCondition.compareSource": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].preCondition.operator": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].preCondition.ignoreCase": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].endCondition.timeoutSec": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].endCondition.compareSource": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].endCondition.operator": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].endCondition.ignoreCase": { phase: VAR_SUBSTITUTION_PHASES.DISPATCH, kind: VAR_SUBSTITUTION_KINDS.VALUE, fencedCodeProtected: false, unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR },
  "steps[].additionalArgs": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "hooks[].command": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "hooks[].env.*": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "preCondition.script": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "preCondition.env.*": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "endCondition.script": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "endCondition.env.*": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "endCondition.retryPrompt": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: true,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "endCondition.passRetryPrompt": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: true,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "scriptStep.script": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "scriptStep.env.*": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "worktree.setup": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
  "defaults.worktree.setup": {
    phase: VAR_SUBSTITUTION_PHASES.DISPATCH,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    fencedCodeProtected: false,
    unresolved: VAR_SUBSTITUTION_UNRESOLVED.ADVISORY,
  },
} as const satisfies Record<
  string,
  {
    phase: VarSubstitutionPhase;
    kind: VarSubstitutionKind;
    fencedCodeProtected: boolean;
    unresolved: VarSubstitutionUnresolved;
  }
>;

/** Fields deliberately excluded from substitution, with the policy reason. */
export const VAR_SUBSTITUTION_EXCLUDED_FIELDS = [
  {
    path: "trustedExternalRoots",
    reason: "Approval is keyed to the authored value.",
  },
  {
    path: "secrets",
    reason: "Secret grant approval is keyed to authored grant names.",
  },
  {
    path: "toolPermissions",
    reason: "Permission posture must match the reviewed value.",
  },
  {
    path: "sandbox",
    reason: "Permission posture must match the reviewed value.",
  },
  {
    path: "sandboxMode",
    reason: "Permission posture must match the reviewed value.",
  },
  {
    path: "mcpServers",
    reason: "Entries launch programs and carry authored secret grants.",
  },
  {
    path: "conditions",
    reason: "Preset definitions and parameter names are author-only contracts.",
  },
  { path: "vars", reason: "Variables are not recursively expanded." },
] as const;
