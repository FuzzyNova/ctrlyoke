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
