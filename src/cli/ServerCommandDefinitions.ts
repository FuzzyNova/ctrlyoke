import { Command, Option } from "commander";

export interface ServerOptions {
  cwd?: string;
  port?: string;
  strictPort?: boolean;
  bind?: string;
  https?: boolean;
  cert?: string;
  key?: string;
  theme?: "auto" | "light" | "dark";
  open?: boolean;
  regenerateToken?: boolean;
  verbose?: boolean;
}

export interface ServerCommandHandlers {
  server(options: ServerOptions): Promise<void>;
}

export function registerServerCommand(
  program: Command,
  handlers: ServerCommandHandlers
): void {
  program
    .command("server")
    .description("Start the hosted ctrlyoke dashboard")
    .option("-d, --cwd <path>", "Workspace root (default: current directory)")
    .option("-p, --port <n>", "Port to listen on")
    .option("--strict-port", "Fail if the requested port is unavailable")
    .option("--bind <addr>", "Address to bind (default: 127.0.0.1)")
    .option("--https", "Enable HTTPS")
    .option("--no-https", "Disable HTTPS")
    .option("--cert <path>", "TLS certificate path")
    .option("--key <path>", "TLS private key path")
    .addOption(
      new Option(
        "--theme <mode>",
        "Dashboard theme (auto, light, dark)"
      ).choices(["auto", "light", "dark"])
    )
    .option("--open", "Open the tokenized URL in the default browser")
    .option("--regenerate-token", "Rotate the persisted server token")
    .option("--verbose", "Enable diagnostic file logging")
    .action(async (options: ServerOptions) => handlers.server(options));
}
