import {
  HARNESS_IDS,
  TEMPLATE_VARIABLE_DEFAULT_SOURCES,
  TEMPLATE_VARIABLE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
  type TemplateVariableDefaultSource,
} from "../types/DashboardConstants";

/** Per-template saved values, intentionally read from each settings scope separately. */
export type TemplateVariableDefaultsByScope = Record<
  string,
  Record<string, string | undefined> | undefined
>;

/** The subset of a template variable needed to resolve its saved default. */
export interface TemplateVariableDefaultDefinition {
  name: string;
  type?: string;
  harness?: string;
  options?: string[];
  default?: string;
  authoredDefault?: string;
}

export type TemplateVariableDefaultIssueReason =
  | "unknown-variable"
  | "invalid-harness"
  | "invalid-select"
  | "linked-model-dropped";

/** An override ignored by the resolver, reusable by the settings editor. */
export interface TemplateVariableDefaultIssue {
  scope: SettingWriteScope;
  variableName: string;
  reason: TemplateVariableDefaultIssueReason;
  linkedHarness?: string;
}

export interface ResolvedTemplateVariableDefault<
  T extends TemplateVariableDefaultDefinition,
> {
  variable: T & {
    authoredDefault?: string;
    defaultSource: TemplateVariableDefaultSource;
  };
}

const HARNESS_VALUES: ReadonlySet<string> = new Set(Object.values(HARNESS_IDS));

/**
 * Resolve one template's declared variable defaults. Workspace and User values
 * merge per variable, except linked models follow their harness's scope as a unit.
 */
export function resolveTemplateVariableDefaults<
  T extends TemplateVariableDefaultDefinition,
>(
  variables: readonly T[],
  userValues: Record<string, string | undefined> | undefined,
  workspaceValues: Record<string, string | undefined> | undefined
): ResolvedTemplateVariableDefault<T>[] {
  const { validValues } = classifyTemplateVariableDefaults(
    variables,
    userValues,
    workspaceValues
  );
  const byName = new Map(variables.map((variable) => [variable.name, variable]));
  const harnessSource = new Map<string, TemplateVariableDefaultSource>();

  for (const variable of variables) {
    if (variable.type !== TEMPLATE_VARIABLE_TYPES.HARNESS) continue;
    harnessSource.set(
      variable.name,
      validValues.workspace?.[variable.name] !== undefined
        ? TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE
        : validValues.user?.[variable.name] !== undefined
          ? TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER
          : TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE
    );
  }

  return variables.map((variable) => {
    const authoredDefault = variable.authoredDefault ?? variable.default;
    let resolved: string | undefined;
    let source: TemplateVariableDefaultSource = TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE;

    if (variable.type === TEMPLATE_VARIABLE_TYPES.MODEL && variable.harness) {
      const pairSource = harnessSource.get(variable.harness);
      if (pairSource === TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE) {
        resolved = validValues.workspace?.[variable.name] ?? authoredDefault;
        source = validValues.workspace?.[variable.name] !== undefined
          ? TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE
          : TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE;
      } else if (pairSource === TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER) {
        resolved = validValues.user?.[variable.name] ?? authoredDefault;
        source = validValues.user?.[variable.name] !== undefined
          ? TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER
          : TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE;
      } else {
        // A model saved outside the harness's selected scope cannot be paired safely.
        resolved = authoredDefault;
      }
    } else if (validValues.workspace?.[variable.name] !== undefined) {
      resolved = validValues.workspace[variable.name];
      source = TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE;
    } else if (validValues.user?.[variable.name] !== undefined) {
      resolved = validValues.user[variable.name];
      source = TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER;
    } else {
      resolved = authoredDefault;
    }

    // Guard a malformed pairing reference even if a caller bypassed TemplateManager's metadata merger.
    if (
      variable.type === TEMPLATE_VARIABLE_TYPES.MODEL &&
      variable.harness &&
      !byName.has(variable.harness)
    ) {
      resolved = validValues.workspace?.[variable.name] ??
        validValues.user?.[variable.name] ?? authoredDefault;
      source = validValues.workspace?.[variable.name] !== undefined
        ? TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE
        : validValues.user?.[variable.name] !== undefined
          ? TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER
          : TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE;
    }

    return {
      variable: {
        ...variable,
        authoredDefault,
        default: resolved,
        defaultSource: source,
      },
    };
  });
}

/** Classify invalid/stale values and return scope maps with ignored entries removed. */
export function classifyTemplateVariableDefaults(
  variables: readonly TemplateVariableDefaultDefinition[],
  userValues: Record<string, string | undefined> | undefined,
  workspaceValues: Record<string, string | undefined> | undefined
): {
  validValues: Partial<Record<SettingWriteScope, Record<string, string>>>;
  issues: TemplateVariableDefaultIssue[];
} {
  const definitions = new Map(variables.map((variable) => [variable.name, variable]));
  const issues: TemplateVariableDefaultIssue[] = [];
  const validValues: Partial<Record<SettingWriteScope, Record<string, string>>> = {};

  for (const [scope, values] of [
    [SETTING_SCOPES.USER, userValues],
    [SETTING_SCOPES.WORKSPACE, workspaceValues],
  ] as const) {
    if (!values) continue;
    const valid: Record<string, string> = {};
    const invalidHarnesses = new Set<string>();
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const variable = definitions.get(name);
      if (!variable) {
        issues.push({ scope, variableName: name, reason: "unknown-variable" });
      } else if (
        variable.type === TEMPLATE_VARIABLE_TYPES.HARNESS &&
        !HARNESS_VALUES.has(value)
      ) {
        invalidHarnesses.add(name);
        issues.push({ scope, variableName: name, reason: "invalid-harness" });
      } else if (
        variable.type === TEMPLATE_VARIABLE_TYPES.SELECT &&
        !variable.options?.includes(value)
      ) {
        issues.push({ scope, variableName: name, reason: "invalid-select" });
      } else {
        valid[name] = value;
      }
    }

    for (const variable of variables) {
      if (variable.type === TEMPLATE_VARIABLE_TYPES.MODEL &&
          variable.harness && invalidHarnesses.has(variable.harness) &&
          Object.hasOwn(values, variable.name)) {
        delete valid[variable.name];
        issues.push({
          scope,
          variableName: variable.name,
          reason: "linked-model-dropped",
          linkedHarness: variable.harness,
        });
      }
    }
    validValues[scope] = valid;
  }

  return { validValues, issues };
}

/** Whether a pin duplicates the value that would resolve without its target scope. */
export function shouldClearTemplateVariableDefaults(
  variables: readonly TemplateVariableDefaultDefinition[],
  targetScope: SettingWriteScope,
  userValues: Record<string, string | undefined> | undefined,
  _workspaceValues: Record<string, string | undefined> | undefined,
  valuesToPin: Record<string, string>
): boolean {
  const baseline = resolveTemplateVariableDefaults(
    variables,
    targetScope === SETTING_SCOPES.USER ? undefined : userValues,
    undefined
  );
  const baselineByName = new Map(
    baseline.map(({ variable }) => [variable.name, variable.default])
  );
  const namesToCompare = new Set(Object.keys(valuesToPin));

  // A harness and its linked models are one saved/cleared unit.
  for (const variable of variables) {
    if (variable.type !== TEMPLATE_VARIABLE_TYPES.HARNESS) continue;
    const linked = variables.filter(
      (candidate) => candidate.type === TEMPLATE_VARIABLE_TYPES.MODEL && candidate.harness === variable.name
    );
    if ([variable.name, ...linked.map(({ name }) => name)].some((name) => namesToCompare.has(name))) {
      if (![variable.name, ...linked.map(({ name }) => name)].every((name) => namesToCompare.has(name))) {
        return false;
      }
    }
  }

  return [...namesToCompare].every(
    (name) => baselineByName.get(name) === valuesToPin[name]
  );
}
