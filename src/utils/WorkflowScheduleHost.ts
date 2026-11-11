import * as os from "os";

/** Host identity for schedule ownership; kept out of webview-safe schedule helpers. */
export function currentScheduleHostId(): string {
  return os.hostname();
}
