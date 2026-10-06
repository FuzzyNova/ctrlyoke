import type { PostMessageFn } from "./WebviewSettingsSync";

/** Shared message-routing surface used by the panel and hosted browser. */
export interface DashboardClientEndpoint {
  routeClientMessage(
    message: unknown,
    postMessage: PostMessageFn,
    clientTag?: string
  ): Promise<void>;
  disconnectClient(clientId: string): void;
  requestThemeCapture?(): void;
}
