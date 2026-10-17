import { Command } from "commander";

export interface LicenseStatusOptions {
  json?: boolean;
}

export interface LicenseActivateOptions {
  stdin?: boolean;
}

export interface LicenseDeactivateOptions {
  yes?: boolean;
}

export interface LicenseCommandHandlers {
  status(options: LicenseStatusOptions): Promise<void>;
  activate(options: LicenseActivateOptions): Promise<void>;
  deactivate(options: LicenseDeactivateOptions): Promise<void>;
}

/**
 * Registers the Pro license commands. Like `secret set`, `activate` never
 * takes the key as an argument, where it would show in the process list and
 * shell history.
 */
export function registerLicenseCommands(
  program: Command,
  handlers: LicenseCommandHandlers
): void {
  const license = program
    .command("license")
    .description(
      "Manage this machine's ctrlyoke Pro license (used by ctrlyoke server for remote access)"
    );

  license
    .command("status")
    .description("Show the license tier and where it is stored; never the key")
    .option("--json", "Emit one versioned JSON result line")
    .action(async (options: LicenseStatusOptions) => handlers.status(options));

  license
    .command("activate")
    .description(
      "Activate a Pro license key on this machine, read from a hidden TTY prompt or stdin"
    )
    .option("--stdin", "Read the license key from stdin")
    .action(async (options: LicenseActivateOptions) =>
      handlers.activate(options)
    );

  license
    .command("deactivate")
    .description(
      "Release this machine's activation and remove the stored license"
    )
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (options: LicenseDeactivateOptions) =>
      handlers.deactivate(options)
    );
}
