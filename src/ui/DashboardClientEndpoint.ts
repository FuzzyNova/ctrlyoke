import type { HarnessStatusString } from "../types/DashboardConstants";

/** Callback for posting messages to a dashboard client. */
export type PostMessageFn = (message: any) => void;

/** Harness availability shown by the dashboard. */
export interface HarnessStatus {
  available: boolean;
  status: HarnessStatusString;
  message?: string;
  installCommand?: string;
}

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
