import * as path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import QRCode from "qrcode";
import {
  EXECUTION_MODES,
  type ServerThemeMode,
  SERVER_BIND_ADDRESSES,
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
  registerServerCommand as registerDefinition,
  type ServerOptions,
} from "./ServerCommandDefinitions";

export interface ResolvedServerSettings {
  cwd: string;
  port: number;
  fallbackPorts: number[];
  bindAddress: string;
  https: boolean;
  certPath: string;
  keyPath: string;
  theme: ServerThemeMode;
  verbose: boolean;
}

type ServerSettingValues = Pick<
  CtrlYokeGlobalSettings["server"],
  "port" | "fallbackPorts" | "bindAddress" | "theme" | "tls"
>;

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
    https: options.https ?? settings.tls.enabled,
    certPath: options.cert ?? settings.tls.certPath,
    keyPath: options.key ?? settings.tls.keyPath,
    theme: options.theme ?? settings.theme,
    verbose: options.verbose ?? configService.get("diagnostics").verboseLogging,
  };
}

export function formatServerBanner(
  url: string,
  lanIps: readonly string[],
  isTty: boolean,
  qr: string,
  https: boolean
): string {
  const link = isTty ? `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\` : url;
  const lines = [`ctrlyoke dashboard: ${link}`];
  for (const ip of lanIps) {
    const lanUrl = url.replace(/\/\/[^/:]+(?=:|\/)/, `//${ip}`);
    lines.push(`LAN: ${lanUrl}`);
  }
  lines.push(qr);
  if (https)
    lines.push("Install the HTTPS certificate on your phone from /cert.");
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

export interface ServerSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function installServerShutdown(
  runtime: { dispose(): void | Promise<void> },
  signals: ServerSignalSource = process,
  exit: (code: number) => void = process.exit
): void {
  let shutdownStarted = false;
  const shutdown = (): void => {
    if (shutdownStarted) {
      exit(0);
      return;
    }
    shutdownStarted = true;
    void Promise.resolve()
      .then(() => runtime.dispose())
      .finally(() => exit(0));
  };
  signals.on("SIGINT", shutdown);
  signals.on("SIGTERM", shutdown);
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
    theme: initial.theme,
    tls: { enabled: initial.https, certPath, keyPath },
  };
  configService.setCliOverlay({
    diagnostics: { verboseLogging: initial.verbose },
    server: serverSettings,
  });

  if (initial.https && (!certPath || !keyPath)) {
    const licenseStore = await import("../platform/OsCredentialStore.js");
    const { LicenseService } = await import("../license/LicenseService.js");
    const service = new LicenseService(new licenseStore.OsCredentialStore());
    const allowed = await service.hasRemoteAccess();
    service.dispose();
    if (!allowed && !isLoopbackBindAddress(initial.bindAddress)) {
      console.warn(
        "Remote access is a Pro feature. HTTPS LAN certificate generation was skipped."
      );
    } else {
      const generated = await new ServerCertificateService().generate(
        path.join(ctrlyokeStateHome(), "certs"),
        initial.bindAddress === SERVER_BIND_ADDRESSES.ALL_INTERFACES
      );
      certPath = generated.certPath;
      keyPath = generated.keyPath;
      configService.setCliOverlay({
        diagnostics: { verboseLogging: initial.verbose },
        server: {
          ...serverSettings,
          tls: { enabled: true, certPath, keyPath },
        },
      });
    }
  }

  const runtime = await createNodeHostedServer({
    cwd,
    mode: EXECUTION_MODES.HEADLESS,
    regenerateToken: options.regenerateToken,
    strictPort: options.strictPort,
  });
  installServerShutdown(runtime);

  const lanIps = runtime.server.getAvailableIps();
  const qr = await QRCode.toString(runtime.url, {
    type: "terminal",
    small: true,
  });
  console.log(
    formatServerBanner(
      runtime.url,
      lanIps,
      !!process.stdout.isTTY,
      qr,
      runtime.url.startsWith("https:")
    )
  );
  if (options.open) {
    await openUrl(runtime.url);
  }
}

export function registerServerCommand(program: Command): void {
  registerDefinition(program, { server: serverCommand });
}
