import * as path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import QRCode from "qrcode";
import {
  EXECUTION_MODES,
  type ServerThemeMode,
  SERVER_BIND_ADDRESSES,
  SETTING_PATHS,
} from "../types/DashboardConstants";
import { configService } from "../config/CtrlYokeConfigService";
import type { CtrlYokeGlobalSettings } from "../types/CtrlYokeSettings";
import {
  createUserConfigBackend,
  createWorkspaceConfigBackend,
} from "../config/FileConfigBackend";
import { createNodeHostedServer } from "../platform/NodeHostServices";
import { ServerCertificateService } from "../server/ServerCertificateService";
import { ctrlyokeStateHome } from "../utils/ProjectStatePaths";
import { isLoopbackBindAddress } from "../utils/NetworkUtils";
import {
  normalizePublicHostname,
  withUrlHostname,
} from "../utils/ServerPublicHostname";
import { PROCESS_SIGNALS } from "../types/DashboardConstants";
import {
  defaultShutdownTimers,
  installTwoStageShutdown,
  type ShutdownSignal,
  type ShutdownSignalSource,
  type ShutdownTimers,
} from "./SignalShutdown";
import {
  registerServerCommand as registerDefinition,
  type ServerOptions,
} from "./ServerCommandDefinitions";

export interface ResolvedServerSettings {
  cwd: string;
  port: number;
  fallbackPorts: number[];
  bindAddress: string;
  /** Normalized `server.publicHostname`, or null when unset or invalid. */
  publicHostname: string | null;
  https: boolean;
  certPath: string;
  keyPath: string;
  /**
   * Set only when `--theme` was passed, and then only as the starting value:
   * the hosted server reads `server.theme` on every page load, so a change
   * made in the dashboard's settings applies without restarting the server.
   */
  theme?: ServerThemeMode;
  verbose: boolean;
}

type ServerSettingValues = Pick<
  CtrlYokeGlobalSettings["server"],
  "port" | "fallbackPorts" | "bindAddress" | "tls"
> &
  Partial<Pick<CtrlYokeGlobalSettings["server"], "publicHostname">>;

export function resolveServerSettings(
  options: ServerOptions,
  cwd = process.cwd(),
  settings: ServerSettingValues = configService.getAll().server
): ResolvedServerSettings {
  const port =
    options.port === undefined ? settings.port : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }
  return {
    cwd: path.resolve(options.cwd ?? cwd),
    port,
    fallbackPorts: options.strictPort ? [] : settings.fallbackPorts,
    bindAddress: options.bind ?? settings.bindAddress,
    publicHostname: normalizePublicHostname(settings.publicHostname),
    https: options.https ?? settings.tls.enabled,
    certPath: options.cert ?? settings.tls.certPath,
    keyPath: options.key ?? settings.tls.keyPath,
    theme: options.theme,
    verbose: options.verbose ?? configService.get("diagnostics").verboseLogging,
  };
}

export function formatServerBanner(
  url: string,
  lanIps: readonly string[],
  isTty: boolean,
  qr: string,
  https: boolean,
  publicUrl: string | null = null
): string {
  const link = isTty ? `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\` : url;
  const lines = [`ctrlyoke dashboard: ${link}`];
  if (publicUrl) lines.push(`Public: ${publicUrl}`);
  for (const ip of lanIps) {
    const lanUrl = url.replace(/\/\/[^/:]+(?=:|\/)/, `//${ip}`);
    lines.push(`LAN: ${lanUrl}`);
  }
  lines.push(qr);
  if (https)
    lines.push("Install the HTTPS certificate on your phone from /cert.");
  lines.push("Press Ctrl+C to stop the server.");
  return lines.join("\n");
}

export function getUrlOpener(
  url: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return {
    command: platform === "darwin" ? "open" : "xdg-open",
    args: [url],
  };
}

async function openUrl(url: string): Promise<void> {
  const { command, args } = getUrlOpener(url);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
}

export type ServerSignalSource = ShutdownSignalSource;

export interface ServerShutdownDependencies {
  signals?: ServerSignalSource;
  exit?: (code: number) => void;
  timers?: ShutdownTimers;
  isInteractive?: boolean;
  countRunningWorkflows?: () => number;
  signalNames?: readonly ShutdownSignal[];
  deadlineMs?: number;
  onMessage?: (message: string) => void;
}

export function installServerShutdown(
  runtime: { dispose(): void | Promise<void> },
  dependencies: ServerShutdownDependencies = {}
): void {
  const platform = process.platform;
  const signalNames = dependencies.signalNames ?? [
    PROCESS_SIGNALS.INTERRUPT,
    PROCESS_SIGNALS.TERMINATE,
    PROCESS_SIGNALS.HANGUP,
    ...(platform === "win32" ? ([PROCESS_SIGNALS.BREAK] as const) : []),
  ];
  installTwoStageShutdown({
    signals: dependencies.signals ?? process,
    signalNames,
    exit: dependencies.exit ?? process.exit,
    timers: dependencies.timers ?? defaultShutdownTimers,
    isInteractive:
      dependencies.isInteractive ??
      Boolean(process.stdin.isTTY && process.stdout.isTTY),
    countRunningWorkflows: dependencies.countRunningWorkflows ?? (() => 0),
    dispose: () => runtime.dispose(),
    deadlineMs: dependencies.deadlineMs ?? 5000,
    confirmationMessage: (count) =>
      `${count} workflow${count === 1 ? " is" : "s are"} still running. Press Ctrl+C again within 3s to stop them and shut down the server.`,
    shutdownMessage: (count) =>
      `Stopping ${count} workflow(s) and shutting down… (press Ctrl+C again to force quit)`,
    forceMessage: "Force quitting.",
    timeoutMessage: () =>
      "Shutdown timed out; runtime.dispose() is still pending, so workflow state, terminals, or child processes may remain.",
    onMessage: dependencies.onMessage ?? ((message) => console.error(message)),
    exitCodeForSignal: (signal) =>
      signal === PROCESS_SIGNALS.INTERRUPT
        ? 130
        : 128 +
          (signal === PROCESS_SIGNALS.TERMINATE
            ? 15
            : signal === PROCESS_SIGNALS.HANGUP
              ? 1
              : 21),
    successExitCode: 0,
    timeoutExitCode: 1,
  });
}

export async function serverCommand(options: ServerOptions): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  configService.setUserBackend(createUserConfigBackend());
  configService.setWorkspaceBackend(createWorkspaceConfigBackend(cwd));
  const initial = resolveServerSettings(options, cwd);
  let certPath = initial.certPath;
  let keyPath = initial.keyPath;
  const serverSettings = {
    port: initial.port,
    fallbackPorts: initial.fallbackPorts,
    bindAddress: initial.bindAddress,
    ...(initial.theme ? { theme: initial.theme } : {}),
    tls: { enabled: initial.https, certPath, keyPath },
  };
  // `--theme` only picks the starting theme; changing it in the dashboard's
  // settings releases the override.
  const applyOverlay = (tls: typeof serverSettings.tls): void =>
    configService.setCliOverlay(
      {
        diagnostics: { verboseLogging: initial.verbose },
        server: { ...serverSettings, tls },
      },
      [SETTING_PATHS.SERVER_THEME]
    );
  applyOverlay(serverSettings.tls);

  if (initial.https && (!certPath || !keyPath)) {
    const licenseStore = await import("../platform/OsCredentialStore.js");
    const { LicenseService } = await import("../license/LicenseService.js");
    const service = new LicenseService(new licenseStore.OsCredentialStore());
    const allowed = await service.canUseRemoteAccess();
    service.dispose();
    if (!allowed && !isLoopbackBindAddress(initial.bindAddress)) {
      console.warn(
        "Remote access is a Pro feature. HTTPS LAN certificate generation was skipped."
      );
    } else {
      const generated = await new ServerCertificateService().generate(
        path.join(ctrlyokeStateHome(), "certs"),
        initial.bindAddress === SERVER_BIND_ADDRESSES.ALL_INTERFACES,
        initial.publicHostname
      );
      certPath = generated.certPath;
      keyPath = generated.keyPath;
      applyOverlay({ enabled: true, certPath, keyPath });
    }
  }

  const runtime = await createNodeHostedServer({
    cwd,
    mode: EXECUTION_MODES.HEADLESS,
    regenerateToken: options.regenerateToken,
    strictPort: options.strictPort,
  });
  installServerShutdown(runtime, {
    countRunningWorkflows: () => runtime.orchestrator.countRunningWorkflows(),
  });

  const lanIps = runtime.server.getAvailableIps();
  // LAN addresses are reported only when the server really listens on all
  // interfaces, which is also the only case where the public hostname applies.
  // The server falls back to localhost without Pro or a trial, so this also
  // keeps the public hostname behind the remote-access license gate.
  const publicUrl =
    initial.publicHostname && lanIps.length > 0
      ? withUrlHostname(runtime.url, initial.publicHostname)
      : null;
  const qr = await QRCode.toString(publicUrl ?? runtime.url, {
    type: "terminal",
    small: true,
  });
  console.log(
    formatServerBanner(
      runtime.url,
      lanIps,
      !!process.stdout.isTTY,
      qr,
      runtime.url.startsWith("https:"),
      publicUrl
    )
  );
  if (options.open) {
    await openUrl(runtime.url);
  }
}

export function registerServerCommand(program: Command): void {
  registerDefinition(program, { server: serverCommand });
}
