import * as path from "node:path";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import {
  SecretStoreUnavailableError,
  type SecretStore,
} from "../platform/SecretStore";
import { OsCredentialStore } from "../platform/OsCredentialStore";
import { CliAdapter, type ResolvedCliConfig } from "../platform/CliAdapter";
import { PromptFileParser } from "../core/PromptFileParser";
import {
  getWorkflowSecretGrants,
  preflightWorkflowSecrets,
} from "../utils/SecretResolver";
import {
  secretGrantsTrustStore,
  type SecretGrantsTrustStore,
} from "../config/SecretGrantsTrustStore";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import {
  userSecretKey,
  validateSecretName,
  workspaceSecretKeyForRoot,
} from "../platform/SecretKey";
import {
  SECRET_REGISTRY_STATES,
  EXECUTION_MODES,
  HARNESS_IDS,
  SETTING_SCOPES,
  TRUST_DECISIONS,
  type SettingWriteScope,
} from "../types/DashboardConstants";
import { SecretRegistryService } from "../ui/SecretRegistryService";
import type { SecretRegistryEntry } from "../types/WebviewMessageTypes";
import { secretRedactionService } from "../utils/SecretRedactionService";
import type { PromptFile } from "../types/CtrlYokeTypes";
import type {
  SecretCheckOptions,
  SecretListOptions,
  SecretRemoveOptions,
  SecretSetOptions,
  TrustSecretGrantsOptions,
} from "./SecretCommandDefinitions";

export interface SecretCommandIo {
  writeOut(message: string): void;
  writeErr(message: string): void;
  readonly isInteractive: boolean;
  confirm(question: string): Promise<boolean>;
  readHidden(prompt: string): Promise<string>;
  readStdin(): Promise<string>;
}

export interface SecretCommandDependencies {
  workspaceRoot: string;
  secretStore: SecretStore;
  platform: PlatformAdapter;
  environment?: NodeJS.ProcessEnv;
  parseWorkflow?(filePath: string): Promise<PromptFile | null>;
  secretGrantsTrustStore?: Pick<
    SecretGrantsTrustStore,
    "getUnallowedGrants" | "setDecisions"
  >;
}

/** Construct the CLI platform contract without introducing a plaintext fallback. */
export function createCliSecretCommandDependencies(
  workspaceRoot: string
): SecretCommandDependencies {
  const secretStore = new OsCredentialStore();
  const config: ResolvedCliConfig = {
    harness: HARNESS_IDS.COPILOT_CLI,
    cwd: workspaceRoot,

    verbose: false,
    quiet: false,
    json: false,
    vars: {},
    cliExecutionMode: EXECUTION_MODES.HEADLESS,
  };
  return {
    workspaceRoot,
    secretStore,
    platform: new CliAdapter(config, secretStore),
    environment: process.env,
  };
}

export async function setSecretCommand(
  name: string,
  options: SecretSetOptions,
  dependencies: SecretCommandDependencies,
  io: SecretCommandIo
): Promise<void> {
  validateSecretName(name);
  const scope = resolveScope(options.scope);
  const workspaceRoot = resolveWorkspaceRoot(
    options.cwd,
    dependencies.workspaceRoot
  );
  const value = options.stdin
    ? await io.readStdin()
    : await readHiddenValue(io);

  await dependencies.secretStore.store(
    secretKeyForScope(scope, workspaceRoot, name),
    value
  );
  io.writeOut(`Stored secret ${name} in ${scope} scope.`);
}

export async function listSecretsCommand(
  options: SecretListOptions,
  dependencies: SecretCommandDependencies,
  io: SecretCommandIo
): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot(
    options.cwd,
    dependencies.workspaceRoot
  );
  const registryStore = await createListingStore(dependencies.secretStore);
  const registry = new SecretRegistryService({
    secretStore: registryStore,
    getWorkspaceRoot: () => workspaceRoot,
    environment: dependencies.environment ?? process.env,
  });

  const entries = (
    await Promise.all([
      registry.list(SETTING_SCOPES.USER),
      registry.list(SETTING_SCOPES.WORKSPACE),
    ])
  ).flat();

  if (entries.length === 0) {
    io.writeOut("No declared or managed secrets found.");
    return;
  }

  for (const entry of entries) {
    io.writeOut(formatSecretEntry(entry));
  }
}

export async function removeSecretCommand(
  name: string,
  options: SecretRemoveOptions,
  dependencies: SecretCommandDependencies,
  io: SecretCommandIo
): Promise<void> {
  validateSecretName(name);
  const scope = resolveScope(options.scope);
  const workspaceRoot = resolveWorkspaceRoot(
    options.cwd,
    dependencies.workspaceRoot
  );
  const confirmed = await confirmMutation(
    options.yes === true,
    io,
    `Remove secret ${name} from ${scope} scope? [y/N] `
  );
  if (!confirmed) {
    io.writeOut("Dry run only; pass --yes to remove the secret.");
    return;
  }

  await dependencies.secretStore.delete(
    secretKeyForScope(scope, workspaceRoot, name)
  );
  io.writeOut(`Removed secret ${name} from ${scope} scope.`);
}

/** Return the command exit code while using the same preflight as `run`. */
export async function checkSecretsCommand(
  file: string | undefined,
  options: SecretCheckOptions,
  dependencies: SecretCommandDependencies,
  io: SecretCommandIo
): Promise<number> {
  if (!file) {
    io.writeErr("Error: Provide a workflow file to check.");
    return 2;
  }

  const workspaceRoot = resolveWorkspaceRoot(
    options.cwd,
    dependencies.workspaceRoot
  );
  const filePath = path.resolve(workspaceRoot, file);
  let workflow: PromptFile | null;
  try {
    workflow = dependencies.parseWorkflow
      ? await dependencies.parseWorkflow(filePath)
      : await new PromptFileParser(dependencies.platform).parsePromptFile(
          filePath
        );
  } catch (error) {
    io.writeErr(`Error: ${errorMessage(error)}`);
    return 2;
  }
  if (!workflow) {
    io.writeErr(`Error: Workflow failed validation: ${filePath}`);
    return 2;
  }

  try {
    await preflightWorkflowSecrets(
      workflow,
      dependencies.platform,
      workspaceRoot,
      dependencies.environment
    );
  } catch (error) {
    io.writeErr(`Secret check failed: ${errorMessage(error)}`);
    return isMissingSecretPreflightError(error) ? 1 : 2;
  }

  io.writeOut(
    `✓ ${path.basename(filePath)}: all declared secrets are resolvable.`
  );
  return 0;
}

export async function trustSecretGrantsCommand(
  file: string,
  options: TrustSecretGrantsOptions,
  dependencies: SecretCommandDependencies,
  io: SecretCommandIo
): Promise<number> {
  const workspaceRoot = resolveWorkspaceRoot(
    options.cwd,
    dependencies.workspaceRoot
  );
  const filePath = path.resolve(workspaceRoot, file);
  let workflow: PromptFile | null;
  try {
    workflow = dependencies.parseWorkflow
      ? await dependencies.parseWorkflow(filePath)
      : await new PromptFileParser(dependencies.platform).parsePromptFile(
          filePath
        );
  } catch (error) {
    io.writeErr(`Error: ${errorMessage(error)}`);
    return 2;
  }
  if (!workflow) {
    io.writeErr(`Error: Workflow failed validation: ${filePath}`);
    return 2;
  }

  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
  const trustStore =
    dependencies.secretGrantsTrustStore ?? secretGrantsTrustStore;
  const requestedGrants = trustStore.getUnallowedGrants(
    workspaceIdentity,
    getWorkflowSecretGrants(workflow)
  );
  if (requestedGrants.length === 0) {
    io.writeOut("No pending secret grants to approve for this workflow.");
    return 0;
  }

  io.writeOut(
    `This workflow requests ${requestedGrants.length} secret grant(s):`
  );
  for (const name of requestedGrants) {
    io.writeOut(`  - ${name}`);
  }
  io.writeOut("");

  if (!options.yes && !io.isInteractive) {
    io.writeErr(
      "Error: Cannot approve secret grants without an interactive terminal. Review the grants above, then rerun with --yes or approve them in the ctrlyoke panel. No decisions were recorded."
    );
    return 2;
  }

  const approved = await confirmMutation(
    options.yes === true,
    io,
    `Trust all ${requestedGrants.length} listed secret grant(s)? [y/N] `
  );
  if (approved) {
    await trustStore.setDecisions(
      workspaceIdentity,
      requestedGrants,
      TRUST_DECISIONS.ALLOW
    );
  } else if (io.isInteractive) {
    await trustStore.setDecisions(
      workspaceIdentity,
      requestedGrants,
      TRUST_DECISIONS.DENY
    );
  }

  if (!approved) {
    io.writeOut(
      "No grants were approved. They remain blocked — rerun with --yes or approve interactively."
    );
    return 0;
  }

  io.writeOut(
    `Approved ${requestedGrants.length} secret grant(s) for this workflow.`
  );
  return 0;
}

export function createSecretCommandIo(): SecretCommandIo {
  return {
    writeOut: (message) => process.stdout.write(redactOutput(message) + "\n"),
    writeErr: (message) => process.stderr.write(redactOutput(message) + "\n"),
    isInteractive: !!process.stdin.isTTY && !!process.stderr.isTTY,
    confirm: promptYesNo,
    readHidden: readHiddenSecret,
    readStdin: readSecretFromStdin,
  };
}

function resolveScope(scope: SettingWriteScope | undefined): SettingWriteScope {
  if (scope === undefined) {
    return SETTING_SCOPES.USER;
  }
  if (scope === SETTING_SCOPES.USER || scope === SETTING_SCOPES.WORKSPACE) {
    return scope;
  }
  throw new Error(
    `Invalid secret scope "${String(scope)}". Use "user" or "workspace".`
  );
}

function resolveWorkspaceRoot(
  cwd: string | undefined,
  fallback: string
): string {
  return path.resolve(cwd ?? fallback);
}

function secretKeyForScope(
  scope: SettingWriteScope,
  workspaceRoot: string,
  name: string
): string {
  if (scope === SETTING_SCOPES.USER) {
    return userSecretKey(name);
  }
  return workspaceSecretKeyForRoot(workspaceRoot, name);
}

function formatSecretEntry(entry: SecretRegistryEntry): string {
  const state =
    entry.state === SECRET_REGISTRY_STATES.MANAGED_AND_SET ||
    entry.state === SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_DETECTED
      ? "set"
      : "unset";
  const source =
    entry.state === SECRET_REGISTRY_STATES.MANAGED_AND_SET
      ? "managed"
      : entry.state === SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_DETECTED
        ? "environment"
        : "unavailable";
  return `${entry.name}  scope=${entry.scope}  state=${state}  source=${source}`;
}

async function createListingStore(
  secretStore: SecretStore
): Promise<SecretStore> {
  try {
    await secretStore.keys();
    return secretStore;
  } catch (error) {
    if (!(error instanceof SecretStoreUnavailableError)) {
      throw error;
    }
    return {
      get: async () => undefined,
      store: async () => {
        throw error;
      },
      delete: async () => {
        throw error;
      },
      keys: async () => [],
    };
  }
}

async function readHiddenValue(io: SecretCommandIo): Promise<string> {
  if (!io.isInteractive) {
    throw new Error("No TTY is available; use --stdin to provide the secret.");
  }
  return io.readHidden("Secret value: ");
}

async function confirmMutation(
  yes: boolean,
  io: SecretCommandIo,
  question: string
): Promise<boolean> {
  if (yes) return true;
  if (!io.isInteractive) return false;
  return io.confirm(question);
}

async function promptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(question);
    return answer.toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

async function readSecretFromStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) {
    value += String(chunk);
  }
  return value.replace(/(?:\r\n|\n|\r)$/, "");
}

async function readHiddenSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stderr = process.stderr;
  if (!stdin.isTTY || !stdin.setRawMode) {
    throw new Error("A hidden TTY prompt is unavailable; use --stdin instead.");
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer | string): void => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          stderr.write("\n");
          reject(new Error("Secret input cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          stderr.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };

    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function redactOutput(message: string): string {
  return secretRedactionService.redactText(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingSecretPreflightError(error: unknown): boolean {
  return (
    errorMessage(error).includes('Secret "') &&
    errorMessage(error).includes(" is missing for scope ")
  );
}
