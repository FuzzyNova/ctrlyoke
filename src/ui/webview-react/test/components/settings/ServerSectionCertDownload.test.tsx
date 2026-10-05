import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerSection } from "@components/settings/ServerSection";
import {
  HOSTED_CERT_DOWNLOAD,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { useSettingsStore } from "@store/settingsStore";
import { downloadBlob } from "@utils/download";
import { isIosDevice } from "@utils/platform";

// The browser-only "Download certificate" button renders only in the hosted
// (standalone) dashboard, which `isStandalone` decides at module load.
vi.mock("@hooks/useVsCodeApi", () => ({
  isStandalone: true,
  useVsCodeApi: () => ({ postMessage: vi.fn() }),
}));

vi.mock("@utils/download", () => ({
  downloadBlob: vi.fn(),
}));

vi.mock("@utils/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@utils/platform")>()),
  isIosDevice: vi.fn(() => false),
}));

const CERT_URL = `${window.location.origin}${HOSTED_CERT_DOWNLOAD.PATH}`;

function createTlsSettings(): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      server: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.server,
        tls: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.server.tls,
          enabled: true,
        },
      },
    },
    sources: {},
    isMultiRoot: false,
  };
}

function renderAndClickDownload() {
  render(
    <ServerSection
      activeScope={SETTING_SCOPES.USER}
      settings={createTlsSettings()}
      onUpdate={vi.fn()}
      onReset={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /Download certificate/ }));
}

describe("ServerSection certificate download (hosted browser)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let clickedLinks: HTMLAnchorElement[];
  let anchorClick: { mockRestore: () => void };

  beforeEach(() => {
    useSettingsStore.setState({
      licenseAccess: { isPro: true, hasRemoteAccess: true, trialEndsAt: null },
    });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    clickedLinks = [];
    anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedLinks.push(this);
      });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    anchorClick.mockRestore();
    vi.mocked(downloadBlob).mockReset();
    vi.mocked(isIosDevice).mockReset().mockReturnValue(false);
  });

  it("saves the cert from an in-page fetch instead of a link download", async () => {
    const certBytes = new TextEncoder().encode("-----BEGIN CERTIFICATE-----");
    fetchMock.mockResolvedValue(new Response(certBytes, { status: 200 }));

    renderAndClickDownload();

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(CERT_URL, { cache: "no-store" });
    const [filename, blob] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toBe(HOSTED_CERT_DOWNLOAD.FILENAME);
    expect(blob.type).toBe(HOSTED_CERT_DOWNLOAD.CONTENT_TYPE);
    expect(clickedLinks).toHaveLength(0);
  });

  it("falls back to a direct link when the in-page fetch fails", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));

    renderAndClickDownload();

    await waitFor(() => expect(clickedLinks).toHaveLength(1));
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("keeps the direct link on iOS, whose profile-install prompt needs it", () => {
    vi.mocked(isIosDevice).mockReturnValue(true);

    renderAndClickDownload();

    expect(clickedLinks).toHaveLength(1);
    const [link] = clickedLinks;
    expect(link.href).toBe(CERT_URL);
    expect(link.download).toBe(HOSTED_CERT_DOWNLOAD.FILENAME);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
