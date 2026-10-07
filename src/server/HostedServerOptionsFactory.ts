import type { HostedServerOptions } from "./CtrlYokeHostedServer";
import type { LicenseService } from "../license/LicenseService";
import type { UserFeedbackSink } from "../core/UserFeedbackSink";
import { notifyUserFeedback } from "../core/UserFeedbackSink";
import { configService } from "../config/CtrlYokeConfigService";
import {
  LICENSE_UI,
  USER_FEEDBACK_SEVERITY,
} from "../types/DashboardConstants";
import type { RunnerHostIdentity } from "../types/CtrlYokeTypes";

type HostedServerOptionOverrides = Pick<
  HostedServerOptions,
  | "hub"
  | "endpoint"
  | "getOrchestrator"
  | "workspaceRoot"
  | "namedWorkspaceRoots"
  | "token"
  | "hostKind"
> & {
  licenseService: LicenseService;
  getUserFeedbackSink: () => UserFeedbackSink;
  runnerHostIdentity?: RunnerHostIdentity;
  onSiblingServerDetected?: (url: string) => void;
  onRemoteAccessBlocked?: () => void;
};

/** Shared config and Pro gate wiring for the VS Code and Node server roots. */
export function createHostedServerOptions(
  overrides: HostedServerOptionOverrides
): HostedServerOptions {
  const server = configService.getAll().server;
  const tls =
    server.tls.enabled && server.tls.certPath && server.tls.keyPath
      ? { certPath: server.tls.certPath, keyPath: server.tls.keyPath }
      : undefined;

  return {
    hub: overrides.hub,
    endpoint: overrides.endpoint,
    getOrchestrator: overrides.getOrchestrator,
    port: server.port,
    fallbackPorts: server.fallbackPorts,
    bindAddress: server.bindAddress,
    ...(tls ? { tls } : {}),
    workspaceRoot: overrides.workspaceRoot,
    namedWorkspaceRoots: overrides.namedWorkspaceRoots,
    token: overrides.token,
    remoteAccess: {
      isAllowed: () => overrides.licenseService.hasRemoteAccess(),
      onBlocked:
        overrides.onRemoteAccessBlocked ??
        (() =>
          notifyRemoteAccessBlocked(overrides.getUserFeedbackSink())),
    },
    runnerHostIdentity: overrides.runnerHostIdentity,
    onSiblingServerDetected: overrides.onSiblingServerDetected,
    hostKind: overrides.hostKind,
  };
}

export function notifyRemoteAccessBlocked(
  sink: UserFeedbackSink | undefined
): void {
  notifyUserFeedback(
    sink,
    USER_FEEDBACK_SEVERITY.WARNING,
    `ctrlyoke: ${LICENSE_UI.REMOTE_ACCESS_UPSELL}`,
    LICENSE_UI.PRICING_URL
  );
}
