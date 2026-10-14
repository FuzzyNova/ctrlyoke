import { describe, it, expect, vi } from "vitest";
import { MESSAGE_TYPES } from "@/types/messages";
import {
  installPanelHandshakeRetry,
  retryPanelHandshake,
} from "@hooks/panelHandshake";
import { getVsCodeApi, panelPageLoadId } from "@hooks/useVsCodeApi";

describe("panel handshake retry", () => {
  // The extension discards a READY whose pageLoadId it already accepted, so a
  // retry that reused the page's own id would be silently ignored.
  it("re-sends READY under a page-load id the extension has not seen", () => {
    const postMessage = vi.mocked(getVsCodeApi().postMessage);
    postMessage.mockClear();

    retryPanelHandshake();
    retryPanelHandshake();

    const ids = postMessage.mock.calls.map(([message]) => {
      expect(message.type).toBe(MESSAGE_TYPES.READY);
      return message.pageLoadId as string;
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(panelPageLoadId);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids.every((id) => id.startsWith(panelPageLoadId))).toBe(true);
  });

  it("exposes the retry to the HTML handshake watchdog", () => {
    installPanelHandshakeRetry();

    expect(window.__ctrlyokeRetryPanelHandshake).toBe(retryPanelHandshake);
  });
});
