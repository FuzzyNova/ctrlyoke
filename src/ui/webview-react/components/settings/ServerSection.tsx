import {
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import {
  HOSTED_CERT_DOWNLOAD,
  LICENSE_UI,
  MESSAGE_TYPES,
  SETTING_PATHS,
  SETTING_SCOPES,
  SERVER_BIND_ADDRESSES,
} from "@root/types/DashboardConstants";
import {
  ICON_BG_COLOR_DEFAULT,
  ICON_FG_COLOR_DEFAULT,
} from "@root/types/IconColorDefaults";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { ActionButton } from "../shared/ActionButton";
import { CustomSelect } from "../shared/CustomSelect";
import { LocalNumberInput, LocalTextInput } from "../shared/LocalInputs";
import { PortListEditor } from "../shared/PortListEditor";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import appIconSvg from "../../../../../images/ctrlyoke-app-icon.svg?raw";
import { Icon } from "../shared/Icon";
import { LucideIcon } from "../shared/LucideIcon";
import { QrCode } from "lucide-react";
import { downloadBlob } from "@utils/download";
import { WebviewLog } from "@utils/logger";
import { isIosDevice } from "@utils/platform";
import { getServerCertLanCoverage } from "@utils/serverCertCoverage";

function buildIconPreviewDataUrl(bgColor: string, fgColor: string): string {
  const svg = appIconSvg
    .replace(new RegExp(ICON_BG_COLOR_DEFAULT, "gi"), bgColor)
    .replace(new RegExp(ICON_FG_COLOR_DEFAULT, "gi"), fgColor);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function ServerSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const server = settings.settings.server;
  const sources = settings.sources as Record<string, SettingSource>;

  const serverRunning = useSettingsStore((state) => state.serverRunning);
  const licenseAccess = useSettingsStore((state) => state.licenseAccess);
  const setActiveTab = useUiStore((s) => s.setGlobalSettingsTab);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const availableIps = useSettingsStore((state) => state.availableIps);
  const selectedDisplayIp = useSettingsStore(
    (state) => state.selectedDisplayIp
  );
  const portFallback = useSettingsStore((state) => state.portFallback);
  const bindAddressFallback = useSettingsStore(
    (state) => state.bindAddressFallback
  );
  const setSelectedDisplayIp = useSettingsStore(
    (state) => state.setSelectedDisplayIp
  );
  const vscode = useVsCodeApi();

  const lastCertGenerated = useSettingsStore((s) => s.lastCertGenerated);
  const certFlashCount = useSettingsStore((s) => s.certFlashCount);
  const lastTokenRegenerated = useSettingsStore((s) => s.lastTokenRegenerated);
  const tokenFlashCount = useSettingsStore((s) => s.tokenFlashCount);
  const lastCertDownloadSaved = useSettingsStore(
    (s) => s.lastCertDownloadSaved
  );
  const certDownloadFlashCount = useSettingsStore(
    (s) => s.certDownloadFlashCount
  );
  const [certPending, setCertPending] = useState(false);
  const [certFlash, setCertFlash] = useState(false);
  const [tokenPending, setTokenPending] = useState(false);
  const [tokenFlash, setTokenFlash] = useState(false);
  const [certDownloadPending, setCertDownloadPending] = useState(false);
  const [certDownloadFlash, setCertDownloadFlash] = useState(false);

  useEffect(() => {
    if (certFlashCount === 0) return;
    setCertPending(false);
    setCertFlash(true);
    const t = setTimeout(() => setCertFlash(false), 3000);
    return () => clearTimeout(t);
  }, [certFlashCount]);

  useEffect(() => {
    if (tokenFlashCount === 0) return;
    setTokenPending(false);
    setTokenFlash(true);
    const t = setTimeout(() => setTokenFlash(false), 2000);
    return () => clearTimeout(t);
  }, [tokenFlashCount]);

  // The download round trip replies whether the file was actually saved or
  // the native dialog was cancelled/failed — either way, clear the spinner;
  // only flash success when a file was actually written.
  useEffect(() => {
    if (certDownloadFlashCount === 0) return;
    setCertDownloadPending(false);
    if (!lastCertDownloadSaved) return;
    setCertDownloadFlash(true);
    const t = setTimeout(() => setCertDownloadFlash(false), 3000);
    return () => clearTimeout(t);
  }, [certDownloadFlashCount, lastCertDownloadSaved]);

  // Safety fallback: clear a stuck spinner if the extension never replies
  // (e.g. cert generation throws before it can send SERVER_CERT_GENERATED).
  useEffect(() => {
    if (!certPending) return;
    const t = setTimeout(() => setCertPending(false), 10000);
    return () => clearTimeout(t);
  }, [certPending]);

  useEffect(() => {
    if (!tokenPending) return;
    const t = setTimeout(() => setTokenPending(false), 10000);
    return () => clearTimeout(t);
  }, [tokenPending]);

  useEffect(() => {
    if (!certDownloadPending) return;
    const t = setTimeout(() => setCertDownloadPending(false), 10000);
    return () => clearTimeout(t);
  }, [certDownloadPending]);

  const certExpired =
    lastCertGenerated != null &&
    new Date(lastCertGenerated.expiresAt) < new Date();
  const certLanCoverage = lastCertGenerated
    ? getServerCertLanCoverage(
        server.bindAddress,
        lastCertGenerated.sans,
        selectedDisplayIp ?? availableIps[0] ?? null
      )
    : null;

  const handleGenerateCert = useCallback(() => {
    if (!licenseAccess.hasRemoteAccess) return;
    setCertPending(true);
    vscode.postMessage({
      type: MESSAGE_TYPES.GENERATE_SERVER_CERT,
      scope: activeScope,
    });
  }, [vscode, activeScope, licenseAccess.hasRemoteAccess]);

  const handleRegenerateToken = useCallback(() => {
    setTokenPending(true);
    vscode.postMessage({ type: MESSAGE_TYPES.REGENERATE_SERVER_TOKEN });
  }, [vscode]);

  const rowProps = { sources, onReset, activeScope };

  const fallbackPorts = useMemo(
    () => server.fallbackPorts ?? [],
    [server.fallbackPorts]
  );
  const handleAddFallbackPort = useCallback(
    (port: number) => {
      onUpdate("server.fallbackPorts", [...fallbackPorts, port]);
    },
    [onUpdate, fallbackPorts]
  );
  const handleRemoveFallbackPort = useCallback(
    (port: number) => {
      onUpdate(
        "server.fallbackPorts",
        fallbackPorts.filter((existing) => existing !== port)
      );
    },
    [onUpdate, fallbackPorts]
  );

  // Only surface the warning while it still describes the currently configured
  // port — if the user already edited the port field to work around the
  // conflict, the stale fallback from the last start no longer applies to it.
  const portFallbackForCurrentSetting =
    portFallback && portFallback.requestedPort === server.port
      ? portFallback
      : null;
  const bindAddressFallbackForCurrentSetting =
    bindAddressFallback &&
    bindAddressFallback.requestedBindAddress === server.bindAddress
      ? bindAddressFallback
      : null;

  const showIpSelector =
    server.bindAddress === SERVER_BIND_ADDRESSES.ALL_INTERFACES &&
    availableIps.length > 1;

  const displayUrl = useMemo(() => {
    if (!serverUrl || !selectedDisplayIp) return serverUrl;
    try {
      const u = new URL(serverUrl);
      u.hostname = selectedDisplayIp;
      return u.toString();
    } catch {
      return serverUrl;
    }
  }, [serverUrl, selectedDisplayIp]);

  const certDownloadUrl = useMemo(() => {
    if (!server.tls?.enabled) return null;
    if (isStandalone) {
      return `${window.location.origin}${HOSTED_CERT_DOWNLOAD.PATH}`;
    }
    if (!displayUrl) return null;
    try {
      const u = new URL(displayUrl);
      u.pathname = HOSTED_CERT_DOWNLOAD.PATH;
      u.search = "";
      return u.toString();
    } catch {
      return null;
    }
  }, [server.tls?.enabled, displayUrl]);

  // Standalone (browser) only: the cert's own /cert endpoint is same-origin
  // there. iOS needs a real link to /cert, because that navigation is what
  // shows its profile-install prompt. Other platforms fetch the bytes in-page
  // and save them from a blob, because Chrome on Android pauses a link
  // download from a server whose certificate isn't trusted yet. That is
  // always the case here, since the user is downloading the cert in order to
  // trust it. The in-page fetch reuses the page's own "proceed anyway"
  // exception, and a blob download makes no second network request.
  const handleDownloadCert = useCallback(async () => {
    if (!certDownloadUrl) return;
    const downloadViaLink = () => {
      const link = document.createElement("a");
      link.href = certDownloadUrl;
      link.download = HOSTED_CERT_DOWNLOAD.FILENAME;
      link.click();
    };
    if (isIosDevice()) {
      downloadViaLink();
      return;
    }
    try {
      const response = await fetch(certDownloadUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      downloadBlob(
        HOSTED_CERT_DOWNLOAD.FILENAME,
        new Blob([bytes], { type: HOSTED_CERT_DOWNLOAD.CONTENT_TYPE })
      );
    } catch (error) {
      WebviewLog.warn(
        "[ServerSection] In-page certificate fetch failed; falling back to a direct link",
        error
      );
      downloadViaLink();
    }
  }, [certDownloadUrl]);

  // VS Code panel only: the webview can't drive an HTTP download through the
  // webview host, so ask the extension to save the cert via a native dialog.
  const handleDownloadCertInPanel = useCallback(() => {
    setCertDownloadPending(true);
    vscode.postMessage({ type: MESSAGE_TYPES.DOWNLOAD_SERVER_CERT });
  }, [vscode]);

  const generatedCertLocation =
    activeScope === SETTING_SCOPES.USER
      ? "~/.ctrlyoke/certs/"
      : ".ctrlyoke/certs/";

  const [showQr, setShowQr] = useState(false);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const displayIpOptions = availableIps.map((ip) => ({ label: ip, value: ip }));
  const bindAddressOptions = [
    {
      label: "Localhost only (127.0.0.1)",
      value: SERVER_BIND_ADDRESSES.LOCALHOST,
    },
    {
      label:
        "All interfaces (0.0.0.0) — LAN access (WAN access with VPN or port forwarding)",
      value: SERVER_BIND_ADDRESSES.ALL_INTERFACES,
      disabled: !licenseAccess.hasRemoteAccess,
      description:
        "Pro feature — unlocks with a Pro license or an active remote-access trial",
      descriptionClassName: "text-pro-brand font-bold",
    },
  ];

  // Local color state: onChange updates preview instantly without persisting.
  // onBlur commits via onUpdate, which persists to settings and triggers server-side PNG regeneration.
  const [localBg, setLocalBg] = useState(
    server.iconBgColor ?? ICON_BG_COLOR_DEFAULT
  );
  const [localFg, setLocalFg] = useState(
    server.iconFgColor ?? ICON_FG_COLOR_DEFAULT
  );
  const customIconEnabled = licenseAccess.isPro;
  // Sync local state if the persisted value changes externally (e.g., reset or another tab).
  useEffect(() => {
    setLocalBg(server.iconBgColor ?? ICON_BG_COLOR_DEFAULT);
  }, [server.iconBgColor]);
  useEffect(() => {
    setLocalFg(server.iconFgColor ?? ICON_FG_COLOR_DEFAULT);
  }, [server.iconFgColor]);

  useEffect(() => {
    if (showQr && qrCanvasRef.current && displayUrl) {
      import("qrcode").then((QRCode) =>
        QRCode.toCanvas(qrCanvasRef.current!, displayUrl, { width: 200 })
      );
    }
  }, [showQr, displayUrl]);

  function toggleServer(enable: boolean) {
    vscode.postMessage({
      type: enable ? MESSAGE_TYPES.ENABLE_SERVER : MESSAGE_TYPES.DISABLE_SERVER,
    });
  }

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Server
      </h3>

      {!licenseAccess.isPro && (
        <button
          type="button"
          onClick={() => setActiveTab("license")}
          aria-label="Unlock Pro Features"
          className="mb-3 flex w-full items-center gap-2 rounded-sm border border-pro-brand px-3 py-2 text-left hover:bg-pro-brand/10"
        >
          <Icon name="key" className="text-pro-brand" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium text-pro-brand">
              Unlock Pro Features
            </span>
            <span className="block text-xs text-description-fg">
              LAN/WAN access, HTTPS, and custom icon colors are all Pro
              features.
            </span>
          </span>
          <Icon name="chevron-right" className="text-pro-brand" />
        </button>
      )}

      <div className="space-y-3">
        {/* Enable on launch — server-side only; browser clients cannot change server startup */}
        {!isStandalone && (
          <SettingToggleRow
            settingKey="server.autoStart"
            checked={server.autoStart}
            onChange={(value) =>
              onUpdate(SETTING_PATHS.SERVER_AUTO_START, value)
            }
            {...rowProps}
          />
        )}

        {/* Start/stop — server-side only */}
        {!isStandalone && (
          <div className="rounded-sm border border-panel-border p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-foreground">Current session</div>
                <div className="text-xs text-description-fg">
                  {serverRunning
                    ? "Server is running for this VS Code session."
                    : "Server is stopped for this VS Code session."}
                </div>
              </div>
              <button
                type="button"
                onClick={() => toggleServer(!serverRunning)}
                className="px-2 py-1 text-xs bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border rounded-sm hover:bg-btn-secondary-hover"
              >
                {serverRunning ? "Stop server" : "Start server"}
              </button>
            </div>
          </div>
        )}

        {/* URL display, copy, QR, regenerate token — server-side only */}
        {!isStandalone && serverRunning && displayUrl && (
          <div>
            {showIpSelector && (
              <SettingInputRow
                settingKey="server.displayAddress"
                id="server-display-ip"
              >
                <CustomSelect
                  id="server-display-ip"
                  value={selectedDisplayIp ?? ""}
                  onChange={setSelectedDisplayIp}
                  options={displayIpOptions}
                  triggerAriaLabel="Choose server connection address"
                  triggerTitle="Choose which detected IP address to display"
                />
              </SettingInputRow>
            )}
            <div className="flex items-center gap-2 p-2 bg-input-bg border border-input-border rounded-sm mt-2">
              <span
                className="w-2 h-2 rounded-full bg-indicator-success shrink-0"
                title="Server running"
              />
              <a
                href={displayUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-link-fg truncate flex-1 hover:underline"
              >
                {displayUrl}
              </a>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(displayUrl)}
                title="Copy URL"
                aria-label="Copy URL"
                className="shrink-0 text-description-fg hover:text-foreground"
              >
                <Icon name="copy" />
              </button>
              <button
                type="button"
                onClick={() => setShowQr((v) => !v)}
                disabled={!licenseAccess.hasRemoteAccess}
                title="Show QR code to open on your phone"
                aria-label="Show QR code to open on your phone"
                className="shrink-0 text-description-fg hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <LucideIcon icon={QrCode} />
              </button>
            </div>
            {!licenseAccess.hasRemoteAccess && (
              <p className="mt-1 text-xs text-description-fg">
                QR-to-phone is available during the remote-access trial and with
                Pro.{" "}
                <a
                  href={LICENSE_UI.PRICING_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link-fg hover:underline"
                >
                  View Pro pricing
                </a>
              </p>
            )}

            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <ActionButton
                label="Regenerate token"
                pendingLabel="Regenerating…"
                successLabel="Token regenerated"
                icon="shield"
                pending={tokenPending}
                success={tokenFlash}
                onClick={handleRegenerateToken}
              />
              {lastTokenRegenerated !== null && !tokenFlash && (
                <span className="text-xs text-description-fg">
                  Restart the server for the new token to take effect.
                </span>
              )}
            </div>

            {showQr && (
              <div className="mt-2 flex flex-col items-center gap-1 p-3 bg-white rounded-sm">
                <canvas ref={qrCanvasRef} />
                <p className="text-xs text-description-fg">
                  Scan to open on your phone
                </p>
              </div>
            )}

            <div className="mt-2 space-y-1 text-xs text-description-fg italic">
              <p>
                ctrlyoke uses the token in this link instead of a user login.
                Treat the link like a password and share it only with people you
                trust. Select the QR code button next to the link to open
                ctrlyoke on your phone, then choose <em>Add to Home Screen</em>{" "}
                or <em>Install app</em> in your browser.
              </p>
              <p>
                Regenerate the token if this link is exposed or someone should
                no longer have access. Like changing a password, this
                invalidates the old link after the server restarts.
              </p>
            </div>
          </div>
        )}

        {/* Port, standalone port, bind address — server-side only; changing these could lock out browser clients */}
        {!isStandalone && (
          <div>
            <SettingInputRow
              settingKey="server.port"
              id="server-port"
              {...rowProps}
            >
              <LocalNumberInput
                id="server-port"
                value={server.port}
                onCommit={(v) => onUpdate("server.port", v)}
                className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
              />
            </SettingInputRow>
            {portFallbackForCurrentSetting && (
              <p className="mt-1 flex items-baseline gap-1 text-xs text-error-fg">
                <Icon name="warning" className="shrink-0 translate-y-px" />
                <span>
                  Port {portFallbackForCurrentSetting.requestedPort} was already
                  in use by another process — ctrlyoke started on port{" "}
                  {portFallbackForCurrentSetting.actualPort} instead. Restart
                  the server to try binding to port{" "}
                  {portFallbackForCurrentSetting.requestedPort} again.
                </span>
              </p>
            )}
          </div>
        )}

        {/* Fallback ports — tried in order before an OS-assigned port; lets a
            workspace pin a stable, bookmarkable URL. Server-side only. */}
        {!isStandalone && (
          <SettingInputRow
            settingKey="server.fallbackPorts"
            id="server-fallback-ports"
            {...rowProps}
          >
            <PortListEditor
              inputId="server-fallback-ports"
              ports={fallbackPorts}
              onAdd={handleAddFallbackPort}
              onRemove={handleRemoveFallbackPort}
            />
          </SettingInputRow>
        )}

        {!isStandalone && (
          <div>
            <SettingInputRow
              settingKey="server.bindAddress"
              id="server-bind"
              {...rowProps}
            >
              <CustomSelect
                id="server-bind"
                value={server.bindAddress ?? SERVER_BIND_ADDRESSES.LOCALHOST}
                onChange={(value) => onUpdate("server.bindAddress", value)}
                schemaPath="server.bindAddress"
                options={bindAddressOptions}
                triggerAriaLabel="Choose server bind address"
                triggerTitle="Choose whether the server listens only on localhost or all interfaces"
              />
            </SettingInputRow>
            {!licenseAccess.hasRemoteAccess && (
              <p className="mt-1 text-xs text-description-fg">
                {LICENSE_UI.REMOTE_ACCESS_UPSELL}{" "}
                <a
                  href={LICENSE_UI.PRICING_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link-fg hover:underline"
                >
                  View Pro pricing
                </a>
              </p>
            )}
            {bindAddressFallbackForCurrentSetting && (
              <p className="mt-1 flex items-baseline gap-1 text-xs text-error-fg">
                <Icon name="warning" className="shrink-0 translate-y-px" />
                <span>
                  ctrlyoke started on localhost only — a Pro license or active
                  remote-access trial is required for All Interfaces (
                  {bindAddressFallbackForCurrentSetting.requestedBindAddress}).
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* Icon Colors — visible to all clients; live SVG preview, colors persist on blur */}
      <div className="relative mt-3 rounded-sm border border-pro-brand px-3 pb-3 pt-2">
        <span className="absolute -top-2 right-2 bg-panel-bg px-1 text-xxs text-pro-brand">
          Pro Feature
        </span>
        <div className="text-xs font-semibold uppercase text-description-fg mb-2 tracking-wide">
          Icon Colors
        </div>
        <div className="mb-2 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <SettingInputRow
                settingKey="server.iconBgColor"
                id="icon-bg-color"
                {...rowProps}
              >
                <input
                  id="icon-bg-color"
                  type="color"
                  value={localBg}
                  onChange={(e) => setLocalBg(e.target.value)}
                  onBlur={(e) => {
                    if (customIconEnabled) {
                      onUpdate("server.iconBgColor", e.target.value);
                    }
                  }}
                  disabled={!customIconEnabled}
                  className="w-full h-8 cursor-pointer rounded-sm border border-input-border p-0.5 bg-input-bg disabled:cursor-not-allowed disabled:opacity-50"
                  title="Icon background color"
                />
              </SettingInputRow>
            </div>
            <div>
              <SettingInputRow
                settingKey="server.iconFgColor"
                id="icon-fg-color"
                {...rowProps}
              >
                <input
                  id="icon-fg-color"
                  type="color"
                  value={localFg}
                  onChange={(e) => setLocalFg(e.target.value)}
                  onBlur={(e) => {
                    if (customIconEnabled) {
                      onUpdate("server.iconFgColor", e.target.value);
                    }
                  }}
                  disabled={!customIconEnabled}
                  className="w-full h-8 cursor-pointer rounded-sm border border-input-border p-0.5 bg-input-bg disabled:cursor-not-allowed disabled:opacity-50"
                  title="Icon foreground color"
                />
              </SettingInputRow>
            </div>
          </div>
          <div className="flex justify-center rounded-sm border border-panel-border bg-editor-bg p-4">
            <img
              src={buildIconPreviewDataUrl(localBg, localFg)}
              alt="Icon preview"
              width={72}
              height={72}
              className="h-[72px] w-[72px] rounded-sm"
            />
          </div>
        </div>
        <p className="text-xs text-description-fg italic">
          SVG favicon and PWA icon update immediately. PNG icon clients (iOS
          &lt; 26 homescreen) use the colors saved at the last settings update.
        </p>
        {!customIconEnabled && (
          <p className="mt-1 text-xs text-description-fg">
            {LICENSE_UI.CUSTOM_ICON_UPSELL}{" "}
            <a
              href={LICENSE_UI.PRICING_URL}
              target="_blank"
              rel="noreferrer"
              className="text-link-fg hover:underline"
            >
              View Pro pricing
            </a>
          </p>
        )}
      </div>

      {/* HTTPS / TLS — full config shown to VS Code panel only */}
      {!isStandalone && (
        <fieldset
          disabled={!licenseAccess.hasRemoteAccess}
          className={`relative mt-3 rounded-sm border border-pro-brand px-3 pb-3 pt-2 ${!licenseAccess.hasRemoteAccess ? "opacity-50" : ""}`}
        >
          <span className="absolute -top-2 right-2 bg-panel-bg px-1 text-xxs text-pro-brand">
            Pro Feature
          </span>
          <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
            HTTPS / TLS
          </h3>
          {!licenseAccess.hasRemoteAccess && (
            <p className="mb-2 text-xs text-description-fg not-italic">
              {LICENSE_UI.REMOTE_ACCESS_UPSELL}{" "}
              <a
                href={LICENSE_UI.PRICING_URL}
                target="_blank"
                rel="noreferrer"
                className="text-link-fg hover:underline"
              >
                View Pro pricing
              </a>
            </p>
          )}

          <SettingToggleRow
            settingKey="server.tls.enabled"
            checked={server.tls?.enabled ?? false}
            onChange={(v) => onUpdate("server.tls.enabled", v)}
            disabled={!licenseAccess.hasRemoteAccess}
            {...rowProps}
          />
          <div className="text-xs text-description-fg italic">
            HTTPS is required for push notifications on mobile browsers, and is
            generally recommended for secure communication. You can provide your
            own TLS certificate and private key, or generate a self-signed
            certificate directly from the dashboard. Changes take effect on
            server restart.
          </div>

          {server.tls?.enabled && (
            <div className="space-y-3 mt-3">
              <SettingInputRow
                settingKey="server.tls.certPath"
                id="tls-cert-path"
                {...rowProps}
              >
                <LocalTextInput
                  id="tls-cert-path"
                  value={server.tls?.certPath ?? ""}
                  placeholder="/path/to/cert.pem"
                  onCommit={(v) => onUpdate("server.tls.certPath", v)}
                  className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground font-mono focus:outline-hidden focus:border-focus-border"
                />
              </SettingInputRow>
              <SettingInputRow
                settingKey="server.tls.keyPath"
                id="tls-key-path"
                {...rowProps}
              >
                <LocalTextInput
                  id="tls-key-path"
                  value={server.tls?.keyPath ?? ""}
                  placeholder="/path/to/key.pem"
                  onCommit={(v) => onUpdate("server.tls.keyPath", v)}
                  className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground font-mono focus:outline-hidden focus:border-focus-border"
                />
              </SettingInputRow>
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-start gap-2">
                  <ActionButton
                    label="Generate self-signed certificate"
                    pendingLabel="Generating…"
                    successLabel="Cert generated"
                    icon="key"
                    pending={certPending}
                    success={certFlash}
                    onClick={handleGenerateCert}
                    disabled={!licenseAccess.hasRemoteAccess}
                  />
                  {certDownloadUrl && !certFlash && (
                    <ActionButton
                      label="Download certificate"
                      pendingLabel="Saving…"
                      successLabel="Certificate saved"
                      icon="download"
                      pending={certDownloadPending}
                      success={certDownloadFlash}
                      onClick={handleDownloadCertInPanel}
                      disabled={!licenseAccess.hasRemoteAccess}
                      title="Save the server certificate to install on a phone or tablet"
                    />
                  )}
                </div>
                {lastCertGenerated && (
                  <div
                    className={`text-xs space-y-0.5 ${certFlash ? "text-indicator-success" : ""}`}
                  >
                    {certExpired ? (
                      <p className="flex items-baseline gap-1 text-error-fg font-medium">
                        <Icon name="warning" />
                        <span>
                          Certificate expired{" "}
                          {new Date(
                            lastCertGenerated.expiresAt
                          ).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </span>
                      </p>
                    ) : (
                      <p className={certFlash ? "" : "text-description-fg"}>
                        Valid{" "}
                        {new Date(
                          lastCertGenerated.generatedAt
                        ).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                        {" → "}
                        {new Date(
                          lastCertGenerated.expiresAt
                        ).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    )}
                    {lastCertGenerated.sans.length > 0 && (
                      <p
                        className={`font-mono ${certFlash ? "" : "text-description-fg"}`}
                      >
                        {lastCertGenerated.sans.join(" · ")}
                      </p>
                    )}
                    {certLanCoverage && !certLanCoverage.covered && (
                      <p className="flex items-baseline gap-1 text-warning-fg">
                        <Icon name="warning" />
                        <span>
                          {certLanCoverage.address
                            ? `This certificate doesn't cover ${certLanCoverage.address}, so phones connecting to it will show a certificate warning.`
                            : "This certificate only covers this computer, so phones on your network will show a certificate warning."}{" "}
                          Generate the certificate again, then restart the
                          server and reinstall it on your phone.
                        </span>
                      </p>
                    )}
                  </div>
                )}
              </div>
              <p className="text-xs text-description-fg italic">
                The generated cert is saved to{" "}
                <code>{generatedCertLocation}</code>
                {activeScope === SETTING_SCOPES.WORKSPACE
                  ? " in the current workspace and gitignored."
                  : " in your user ctrlyoke folder."}{" "}
                Browsers will show a warning on first visit — click proceed to
                continue. Changes take effect on server restart.
              </p>
              <CertInstallHelp onDevice={false} />
            </div>
          )}
        </fieldset>
      )}

      {/* Certificate download — browser clients only; VS Code panel shows this inside the TLS section above */}
      {isStandalone && certDownloadUrl && (
        <div className="pt-3 border-t border-panel-border mt-3">
          <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
            HTTPS / TLS
          </h3>
          <ActionButton
            label="Download certificate"
            icon="download"
            onClick={() => void handleDownloadCert()}
            disabled={!licenseAccess.hasRemoteAccess}
            title="Download the server certificate to install on this device"
          />
          {!licenseAccess.hasRemoteAccess && (
            <p className="mt-2 text-xs text-description-fg">
              {LICENSE_UI.REMOTE_ACCESS_UPSELL}{" "}
              <a
                href={LICENSE_UI.PRICING_URL}
                target="_blank"
                rel="noreferrer"
                className="text-link-fg hover:underline"
              >
                View Pro pricing
              </a>
            </p>
          )}
          <CertInstallHelp onDevice className="mt-2" />
        </div>
      )}
    </div>
  );
}

/** A menu path or button name inside the italic help text, set upright so
 * the thing to tap stands out from the explanation around it. */
function MenuPath({ children }: { children: ReactNode }) {
  return <span className="not-italic text-foreground">{children}</span>;
}

/** A titled list of help items: numbered steps, or bullets for alternatives. */
function HelpSteps({
  title,
  bulleted = false,
  children,
}: {
  title: string;
  bulleted?: boolean;
  children: ReactNode;
}) {
  const List = bulleted ? "ul" : "ol";
  return (
    <div>
      <p className="font-semibold">{title}</p>
      <List
        className={`${bulleted ? "list-disc" : "list-decimal"} pl-5 space-y-0.5`}
      >
        {children}
      </List>
    </div>
  );
}

/**
 * The opening steps every platform shares: get ctrlyoke open on the device,
 * then download the cert there. From the VS Code panel that starts with the
 * QR code; on the device itself the download button sits just above.
 */
function CertDownloadSteps({
  onDevice,
  afterDownload,
}: {
  onDevice: boolean;
  afterDownload?: ReactNode;
}) {
  if (onDevice) {
    return (
      <li>
        Tap <MenuPath>Download certificate</MenuPath> above{afterDownload}.
      </li>
    );
  }
  return (
    <>
      <li>
        Select{" "}
        <LucideIcon
          icon={QrCode}
          size={12}
          aria-label="the QR code button"
          className="align-[-2px] not-italic text-foreground"
        />{" "}
        next to the server link above to show the QR code, then scan it with the
        device&apos;s camera to open ctrlyoke in its browser.
      </li>
      <li>
        On the device, open <MenuPath>Global Settings → Server</MenuPath> and
        tap <MenuPath>Download certificate</MenuPath>
        {afterDownload}.
      </li>
    </>
  );
}

/** Per-platform steps for trusting the downloaded server certificate and
 * installing the dashboard as an app. `onDevice` is true in the browser
 * dashboard, which is already open on the phone or tablet being set up. */
function CertInstallHelp({
  onDevice,
  className = "",
}: {
  onDevice: boolean;
  className?: string;
}) {
  return (
    <div
      className={`text-xs text-description-fg italic space-y-2 ${className}`}
    >
      <HelpSteps title="iPhone / iPad (Safari, iOS 18.2+)">
        <CertDownloadSteps
          onDevice={onDevice}
          afterDownload={
            <>
              , then <MenuPath>Allow</MenuPath>
            </>
          }
        />
        <li>
          Install the profile:{" "}
          <MenuPath>Settings → General → VPN &amp; Device Management</MenuPath>.
        </li>
        <li>
          Turn on full trust for <em>ctrlyoke Local CA</em>:{" "}
          <MenuPath>
            Settings → General → About → Certificate Trust Settings
          </MenuPath>
          . Easy to miss, and required.
        </li>
      </HelpSteps>
      <HelpSteps title="Android (Chrome)">
        <CertDownloadSteps onDevice={onDevice} />
        <li>
          Install it from the Settings app (tapping the downloaded file
          won&apos;t):{" "}
          <MenuPath>
            Settings → Security &amp; privacy → More security settings
          </MenuPath>
          , then:
          <ul className="list-disc pl-5">
            <li>
              Samsung:{" "}
              <MenuPath>Install from device storage → CA certificate</MenuPath>
            </li>
            <li>
              Pixel and most others:{" "}
              <MenuPath>
                Encryption &amp; credentials → Install a certificate → CA
                certificate
              </MenuPath>
            </li>
          </ul>
          Not there? Search Settings for &quot;CA certificate&quot;.
        </li>
        <li>
          Tap <MenuPath>Install anyway</MenuPath> and pick{" "}
          <MenuPath>{HOSTED_CERT_DOWNLOAD.FILENAME}</MenuPath>.
        </li>
        <li>
          Fully quit Chrome (swipe every window away in Recent apps) and reopen
          it. Until then it still treats the cert as untrusted.
        </li>
      </HelpSteps>
      <HelpSteps title="Install the app" bulleted>
        <li>
          Android: Chrome&apos;s{" "}
          <MenuPath>⋮ → Install and create shortcut → Install</MenuPath> (older
          versions: <MenuPath>Install app</MenuPath>).{" "}
          <MenuPath>Create shortcut</MenuPath> only opens a Chrome tab.
        </li>
        <li>
          iPhone / iPad: Safari&apos;s{" "}
          <MenuPath>Share → Add to Home Screen</MenuPath>.
        </li>
      </HelpSteps>
    </div>
  );
}
