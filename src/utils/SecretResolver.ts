import {
  isScriptStep,
  type PromptFile,
  type UserHookConfig,
  type WorkflowStep,
} from "../types/CtrlYokeTypes";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import type { SecretStore } from "../platform/SecretStore";
import {
  isValidSecretName,
  userSecretKey,
  workspaceSecretKeyForRoot,
} from "../platform/SecretKey";
import { getEffectiveSecretGrants } from "./SecretReferenceParser";

const SECRET_INTERPOLATION_PATTERN = /\$\{secret:([^}]+)\}/g;

export type SecretValueSource = "environment" | "workspace" | "user";

export interface ResolvedSecretValue {
  value: string;
  source: SecretValueSource;
}

export class MissingSecretError extends Error {
  readonly secretName: string;
  readonly scope = "workspace/user or environment";

  constructor(name: string) {
    super(
      `Secret "${name}" is not resolvable in scope "workspace/user or environment". ` +
        "Set it in the managed secret store or provide it through the host environment."
    );
    this.secretName = name;
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

/** Prompt bodies are never a resolution boundary. */
export function assertNoSecretInterpolationInPrompt(prompt: string): void {
  SECRET_INTERPOLATION_PATTERN.lastIndex = 0;
  const match = SECRET_INTERPOLATION_PATTERN.exec(prompt);
  if (match) {
    throw new Error(
      `Secret interpolation is not allowed in prompt text ("${match[0]}"). ` +
        "Use !NAME to grant an environment variable to the step."
    );
  }
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
  const inherited = step.secrets ?? workflow.secrets ?? [];
  return getEffectiveSecretGrants(step, inherited);
}

function getProcessMaps(
  step: WorkflowStep,
  workflow: PromptFile
): Array<Record<string, string> | undefined> {
  const mcpServers = isScriptStep(step)
    ? (workflow.mcpServers ?? [])
    : (step.mcpServers ?? workflow.mcpServers ?? []);
  const mcpMaps = mcpServers.flatMap((server) =>
    typeof server === "string" ? [] : [server.env, server.headers]
  );
  const hooks = isScriptStep(step)
    ? (workflow.hooks ?? [])
    : (step.hooks ?? workflow.hooks ?? []);
  const hookMaps = hooks.map((hook: UserHookConfig) => hook.env);
  const scriptMaps = isScriptStep(step) ? [step.env] : [];
  const conditionMaps = isScriptStep(step)
    ? []
    : [step.preCondition?.env, step.endCondition?.env];
  const workflowConditionMaps = [
    workflow.preCondition?.env,
    workflow.endCondition?.env,
  ];
  return [
    ...mcpMaps,
    ...hookMaps,
    ...scriptMaps,
    ...conditionMaps,
    ...workflowConditionMaps,
  ];
}

/** Shared run preflight used by execution and the future `secret check` command. */
export async function preflightWorkflowSecrets(
  workflow: PromptFile,
  platform: PlatformAdapter,
  workspaceRoot: string
): Promise<void> {
  const assertConditionPrompts = (
    condition: object | null | undefined
  ): void => {
    const prompts = condition as
      | { retryPrompt?: unknown; passRetryPrompt?: unknown }
      | null
      | undefined;
    if (typeof prompts?.retryPrompt === "string") {
      assertNoSecretInterpolationInPrompt(prompts.retryPrompt);
    }
    if (typeof prompts?.passRetryPrompt === "string") {
      assertNoSecretInterpolationInPrompt(prompts.passRetryPrompt);
    }
  };

  if (workflow.prompt !== undefined) {
    assertNoSecretInterpolationInPrompt(workflow.prompt);
  }
  assertConditionPrompts(workflow.preCondition);
  assertConditionPrompts(workflow.endCondition);

  const steps = [
    ...(workflow.steps ?? []),
    ...(workflow.finalStep ? [workflow.finalStep] : []),
  ];
  for (const [index, step] of steps.entries()) {
    const scope = step.name?.trim() || `step ${index + 1}`;
    if ("prompt" in step) {
      assertNoSecretInterpolationInPrompt(step.prompt);
    }
    if (!isScriptStep(step)) {
      assertConditionPrompts(step.preCondition);
      assertConditionPrompts(step.endCondition);
    }
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
    if (grants.length > 0) {
      try {
        const missing = await findMissingSecretNames(grants, {
          workspaceRoot,
          secretStore: platform.getSecretStore?.(),
        });
        if (missing.length > 0) {
          throw new MissingSecretError(missing[0]);
        }
      } catch (error) {
        if (error instanceof MissingSecretError) {
          throw new Error(
            `Secret "${error.secretName}" is missing for scope "${scope}" (${error.scope}).`
          );
        }
        throw error;
      }
    }
  }
}
