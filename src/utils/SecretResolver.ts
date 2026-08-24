import {
  isScriptStep,
  type ExecutionProperties,
  type McpServerConfig,
  type PromptFile,
  type UserHookConfig,
  type WorkflowStep,
} from "../types/CtrlYokeTypes";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import {
  SecretStoreUnavailableError,
  type SecretStore,
} from "../platform/SecretStore";
import {
  isValidSecretName,
  userSecretKey,
  workspaceSecretKeyForRoot,
} from "../platform/SecretKey";
import {
  SecretGrantsTrustStore,
  secretGrantsTrustStore,
} from "../config/SecretGrantsTrustStore";
import { getEffectiveSecretGrants } from "./SecretReferenceParser";

const SECRET_INTERPOLATION_PATTERN = /\$\{secret:([^}]+)\}/g;

export type SecretValueSource = "environment" | "workspace" | "user";

export interface ResolvedSecretValue {
  value: string;
  source: SecretValueSource;
}

export class MissingSecretError extends Error {
  readonly secretName: string;
  readonly secretNames: readonly string[];
  readonly scope = "workspace/user or environment";

  constructor(name: string, names: readonly string[] = [name]) {
    super(
      `Secret "${name}" is not resolvable in scope "workspace/user or environment". ` +
        "Set it in the managed secret store or provide it through the host environment."
    );
    this.secretName = name;
    this.secretNames = [...names];
    this.name = "MissingSecretError";
  }
}

export interface SecretResolutionContext {
  workspaceRoot: string;
  secretStore?: SecretStore;
  environment?: NodeJS.ProcessEnv;
}

/** Resolve only declared secret names. Values never appear in diagnostics. */
export async function resolveSecretValues(
  names: readonly string[],
  context: SecretResolutionContext
): Promise<Record<string, ResolvedSecretValue>> {
  const environment = context.environment ?? process.env;
  const resolved: Record<string, ResolvedSecretValue> = {};

  for (const name of new Set(names)) {
    if (!isValidSecretName(name)) {
      throw new Error(`Invalid secret name "${name}"`);
    }

    if (Object.prototype.hasOwnProperty.call(environment, name)) {
      const value = environment[name];
      if (value !== undefined) {
        resolved[name] = { value, source: "environment" };
        continue;
      }
    }

    if (context.secretStore) {
      try {
        const workspaceValue = await context.secretStore.get(
          workspaceSecretKeyForRoot(context.workspaceRoot, name)
        );
        if (workspaceValue !== undefined) {
          resolved[name] = { value: workspaceValue, source: "workspace" };
          continue;
        }

        const userValue = await context.secretStore.get(userSecretKey(name));
        if (userValue !== undefined) {
          resolved[name] = { value: userValue, source: "user" };
          continue;
        }
      } catch (error) {
        if (!(error instanceof SecretStoreUnavailableError)) {
          throw error;
        }
        // An unavailable credential backend is equivalent to having no
        // managed value. Environment passthrough remains the supported CI
        // path, and a missing value still gets the normal named preflight
        // error below.
      }
    }

    throw new MissingSecretError(name);
  }

  return resolved;
}

export async function resolveSecretEnvironment(
  names: readonly string[],
  context: SecretResolutionContext
): Promise<Record<string, string>> {
  const values = await resolveSecretValues(names, context);
  return Object.fromEntries(
    Object.entries(values).map(([name, resolved]) => [name, resolved.value])
  );
}

/** Return names that cannot currently resolve without exposing any values. */
export async function findMissingSecretNames(
  names: readonly string[],
  context: SecretResolutionContext
): Promise<string[]> {
  const missing: string[] = [];
  for (const name of new Set(names)) {
    try {
      await resolveSecretValues([name], context);
    } catch (error) {
      if (error instanceof MissingSecretError) {
        missing.push(name);
        continue;
      }
      throw error;
    }
  }
  return missing;
}

/**
 * Prompt bodies are never a resolution boundary — `${secret:NAME}` in prompt
 * text is passed through verbatim, never substituted.
 *
 * This deliberately only *detects*; it must never throw. Prompt text is
 * frequently documentation about ctrlyoke itself (plans, instruction files,
 * and prompts that quote this very syntax), so treating the token's presence
 * as an authoring error blocked legitimate runs that merely mentioned it.
 * Callers report the returned tokens as an advisory diagnostic instead.
 */
export function findSecretInterpolationsInPrompt(prompt: string): string[] {
  SECRET_INTERPOLATION_PATTERN.lastIndex = 0;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = SECRET_INTERPOLATION_PATTERN.exec(prompt)) !== null) {
    found.add(match[0]);
  }
  return [...found];
}

export function collectSecretInterpolationNames(
  value: Record<string, string> | undefined
): string[] {
  if (!value) return [];
  const names = new Set<string>();
  for (const entry of Object.values(value)) {
    SECRET_INTERPOLATION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SECRET_INTERPOLATION_PATTERN.exec(entry)) !== null) {
      if (!isValidSecretName(match[1])) {
        throw new Error(`Invalid secret interpolation name "${match[1]}"`);
      }
      names.add(match[1]);
    }
  }
  return [...names];
}

export function getProcessMapSecretNames(
  properties: Pick<
    ExecutionProperties,
    "mcpServers" | "hooks" | "preCondition" | "endCondition"
  > & { env?: Record<string, string> }
): string[] {
  const maps: Array<Record<string, string> | undefined> = [properties.env];
  const mcpServers = properties.mcpServers ?? [];
  maps.push(
    ...mcpServers.flatMap((server: string | McpServerConfig) =>
      typeof server === "string" ? [] : [server.env, server.headers]
    )
  );
  maps.push(...(properties.hooks ?? []).map((hook) => hook.env));
  maps.push(properties.preCondition?.env, properties.endCondition?.env);

  return [
    ...new Set(maps.flatMap((map) => collectSecretInterpolationNames(map))),
  ];
}

export function expandSecretInterpolations(
  value: Record<string, string> | undefined,
  resolvedValues: Record<string, string>,
  grantedNames: readonly string[]
): Record<string, string> | undefined {
  if (!value) return undefined;
  const grants = new Set(grantedNames);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      SECRET_INTERPOLATION_PATTERN.lastIndex = 0;
      const expanded = entry.replace(
        SECRET_INTERPOLATION_PATTERN,
        (_match, name: string) => {
          if (!isValidSecretName(name)) {
            throw new Error(`Invalid secret interpolation name "${name}"`);
          }
          if (!grants.has(name)) {
            throw new Error(
              `Secret "${name}" is referenced by a process environment map but is not granted to this step.`
            );
          }
          const resolved = resolvedValues[name];
          if (resolved === undefined) {
            throw new MissingSecretError(name);
          }
          return resolved;
        }
      );
      return [key, expanded];
    })
  );
}

/** Build the child-process environment for a granted secret set. */
export function buildSecretProcessEnvironment(
  processEnv: Record<string, string> | undefined,
  resolvedValues: Record<string, string>,
  grantedNames: readonly string[]
): Record<string, string> | undefined {
  const expanded = expandSecretInterpolations(
    processEnv,
    resolvedValues,
    grantedNames
  );
  if (Object.keys(resolvedValues).length === 0 && expanded === undefined) {
    return undefined;
  }
  return { ...resolvedValues, ...(expanded ?? {}) };
}

export function getDeclaredSecretGrants(
  step: WorkflowStep,
  workflow: PromptFile
): string[] {
  // Mirror `select()` in ExecutionPropertyResolver: a step-level value wins
  // whenever it is present, and an explicit `null` clears the inherited array
  // rather than falling back to it. `??` would treat that `null` as "absent"
  // and re-inherit the workflow grants, injecting a secret the step opted out
  // of. Inline `!NAME` references still grant — that asymmetry is deliberate.
  const declared = step.secrets !== undefined ? step.secrets : workflow.secrets;
  return getEffectiveSecretGrants(
    step,
    declared ?? [],
    getProcessMaps(step, workflow).flatMap((map) =>
      collectSecretInterpolationNames(map)
    )
  );
}

export function getWorkflowSecretGrants(workflow: PromptFile): string[] {
  const grants = new Set<string>();
  const steps = [
    ...(workflow.steps ?? []),
    ...(workflow.finalStep ? [workflow.finalStep] : []),
  ];

  for (const step of steps) {
    for (const name of getDeclaredSecretGrants(step, workflow)) {
      grants.add(name);
    }
  }

  return [...grants];
}

function getProcessMaps(
  step: WorkflowStep,
  workflow: PromptFile
): Array<Record<string, string> | undefined> {
  const mcpServers = isScriptStep(step)
    ? (workflow.mcpServers ?? [])
    : step.mcpServers !== undefined
      ? (step.mcpServers ?? [])
      : (workflow.mcpServers ?? []);
  const mcpMaps = mcpServers.flatMap((server) =>
    typeof server === "string" ? [] : [server.env, server.headers]
  );
  const hooks = isScriptStep(step)
    ? (workflow.hooks ?? [])
    : getEffectiveHookConfigs(step.hooks, workflow.hooks);
  const hookMaps = hooks.map((hook: UserHookConfig) => hook.env);
  const scriptMaps = isScriptStep(step) ? [step.env] : [];
  const conditionMaps = isScriptStep(step)
    ? []
    : [
        (step.preCondition === null
          ? undefined
          : (step.preCondition ?? workflow.preCondition)
        )?.env,
        (step.endCondition === null
          ? undefined
          : (step.endCondition ?? workflow.endCondition)
        )?.env,
      ];
  return [...mcpMaps, ...hookMaps, ...scriptMaps, ...conditionMaps];
}

function getEffectiveHookConfigs(
  stepHooks: UserHookConfig[] | null | undefined,
  workflowHooks: UserHookConfig[] | null | undefined
): UserHookConfig[] {
  if (stepHooks === null) return [];

  const inheritedHooks = workflowHooks ?? [];
  if (stepHooks === undefined || stepHooks.length === 0) {
    return inheritedHooks;
  }

  const overriddenEvents = new Set(stepHooks.map((hook) => hook.event));
  return [
    ...inheritedHooks.filter((hook) => !overriddenEvents.has(hook.event)),
    ...stepHooks,
  ];
}

/** Shared run preflight used by execution and the `secret check` command. */
export async function preflightWorkflowSecrets(
  workflow: PromptFile,
  platform: PlatformAdapter,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  {
    failOnMissing = true,
    trustStore = secretGrantsTrustStore,
  }: {
    failOnMissing?: boolean;
    trustStore?: Pick<SecretGrantsTrustStore, "getDecision">;
  } = {}
): Promise<string[]> {
  const missingSecretNames = new Set<string>();
  const workflowGrants = getWorkflowSecretGrants(workflow);
  const unapprovedGrants = workflowGrants.filter(
    (name) => trustStore.getDecision(workspaceRoot, name) !== "allow"
  );

  // Prompt-text `${secret:NAME}` is deliberately *not* checked here. It is
  // never substituted, and a prompt merely quoting the syntax is legitimate,
  // so it is surfaced as a per-step advisory by WorkflowExecutor rather than
  // blocking the run. Env-map interpolation below is a different case: those
  // maps really do interpolate, so an ungranted name there stays an error.
  const steps = [
    ...(workflow.steps ?? []),
    ...(workflow.finalStep ? [workflow.finalStep] : []),
  ];
  for (const [index, step] of steps.entries()) {
    const scope = step.name?.trim() || `step ${index + 1}`;
    const grants = getDeclaredSecretGrants(step, workflow);
    const mapNames = getProcessMaps(step, workflow).flatMap((map) =>
      collectSecretInterpolationNames(map)
    );
    for (const name of mapNames) {
      if (!grants.includes(name)) {
        throw new Error(
          `Secret "${name}" is referenced in process environment for scope "${scope}" but is not granted to that step.`
        );
      }
    }
    try {
      if (unapprovedGrants.length > 0) {
        for (const name of unapprovedGrants) {
          missingSecretNames.add(name);
        }
        throw new MissingSecretError(unapprovedGrants[0], unapprovedGrants);
      }
      if (grants.length > 0) {
        const missing = await findMissingSecretNames(grants, {
          workspaceRoot,
          secretStore: platform.getSecretStore?.(),
          environment,
        });
        if (missing.length > 0) {
          if (failOnMissing) {
            throw new MissingSecretError(missing[0], missing);
          }
          for (const name of missing) {
            missingSecretNames.add(name);
          }
        }
      }
    } catch (error) {
      if (error instanceof MissingSecretError) {
        const missingNames = error.secretNames.map(
          (name) =>
            `Secret "${name}" is missing for scope "${scope}" (${error.scope}).`
        );
        throw new Error(missingNames.join(" "));
      }
      throw error;
    }
  }
  return [...missingSecretNames];
}
