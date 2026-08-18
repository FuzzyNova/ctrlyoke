import { Command } from "commander";
import {
  SETTING_SCOPES,
  type SettingWriteScope,
} from "../types/DashboardConstants";

export interface SecretSetOptions {
  scope?: SettingWriteScope;
  stdin?: boolean;
  cwd?: string;
}

export interface SecretListOptions {
  cwd?: string;
}

export interface SecretRemoveOptions {
  scope?: SettingWriteScope;
  yes?: boolean;
  cwd?: string;
}

export interface SecretCheckOptions {
  cwd?: string;
}

export interface SecretCommandHandlers {
  set(name: string, options: SecretSetOptions): Promise<void>;
  list(options: SecretListOptions): Promise<void>;
  remove(name: string, options: SecretRemoveOptions): Promise<void>;
  check(file: string | undefined, options: SecretCheckOptions): Promise<void>;
}

/** Registers the value-free CLI surface for managed secrets. */
export function registerSecretCommands(
  program: Command,
  handlers: SecretCommandHandlers
): void {
  const secret = program
    .command("secret")
    .description(
      "Manage named secrets; ctrlyoke run also works with env passthrough when no credential backend is available"
    );

  secret
    .command("set <NAME>")
    .description("Store a secret from a hidden TTY prompt or stdin")
    .option(
      "--scope <scope>",
      `Storage scope: ${SETTING_SCOPES.USER} or ${SETTING_SCOPES.WORKSPACE}`,
      SETTING_SCOPES.USER
    )
    .option("--stdin", "Read the secret value from stdin")
    .option(
      "-d, --cwd <path>",
      "Workspace directory (default: current directory)"
    )
    .action(async (name: string, options: SecretSetOptions) =>
      handlers.set(name, options)
    );

  secret
    .command("list")
    .description(
      "List secret names, scopes, set state, and source; never values"
    )
    .option(
      "-d, --cwd <path>",
      "Workspace directory (default: current directory)"
    )
    .action(async (options: SecretListOptions) => handlers.list(options));

  secret
    .command("rm <NAME>")
    .description("Remove a managed secret")
    .option(
      "--scope <scope>",
      `Storage scope: ${SETTING_SCOPES.USER} or ${SETTING_SCOPES.WORKSPACE}`,
      SETTING_SCOPES.USER
    )
    .option("-y, --yes", "Skip the confirmation prompt")
    .option(
      "-d, --cwd <path>",
      "Workspace directory (default: current directory)"
    )
    .action(async (name: string, options: SecretRemoveOptions) =>
      handlers.remove(name, options)
    );

  secret
    .command("check [file]")
    .description(
      "Check a workflow's declared secrets without starting a harness"
    )
    .option(
      "-d, --cwd <path>",
      "Workspace directory (default: current directory)"
    )
    .action(async (file: string | undefined, options: SecretCheckOptions) =>
      handlers.check(file, options)
    );
}
