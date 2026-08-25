import * as fs from "fs";
import * as path from "path";
import {
  buildHookNotificationEvent,
  type CtrlYokeNotificationEvent,
  type HookArtifact,
} from "../../../ui/notifications/CompletionNotificationFactory";
import { configService } from "../../../config/CtrlYokeConfigService";
import { Log } from "../../../utils/Log";

const POLL_INTERVAL_MS = 500;

interface HookEventMonitorOptions {
  runId: string;
  notifyDir: string;
  onEvent: (event: CtrlYokeNotificationEvent) => void;
}

/**
 * HookEventMonitor
 *
 * Polls the notify directory every 500 ms for hook artifact files matching
 * `{runId}-hook-*.json` — written by hook scripts when
 * `CTRLYOKE_NOTIFY_HOOK_EVENTS` lists the event.
 *
 * On each poll cycle the monitor reads every matching file, parses the
 * HookArtifact payload, deletes the file, builds a CtrlYokeNotificationEvent
 * (respecting current notification settings), and fires the `onEvent` callback.
 */
export class HookEventMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly filePrefix: string;

  constructor(private readonly opts: HookEventMonitorOptions) {
    this.filePrefix = `${opts.runId}-hook-`;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Final poll to drain any artifacts written just before stop.
    void this.poll();
  }

  private async poll(): Promise<void> {
    let files: string[];
    try {
      files = fs.readdirSync(this.opts.notifyDir);
    } catch {
      return;
    }

    const matching = files.filter(
      (f) => f.startsWith(this.filePrefix) && f.endsWith(".json")
    );

    for (const file of matching) {
      const filePath = path.join(this.opts.notifyDir, file);
      let artifact: HookArtifact;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        artifact = JSON.parse(raw) as HookArtifact;
        fs.unlinkSync(filePath);
      } catch (err) {
        Log.trace(`[HookEventMonitor] failed to read/delete ${file}: ${err}`);
        continue;
      }

      try {
        const settings = configService.getAll().notifications;
        const event = buildHookNotificationEvent(artifact, settings);
        if (event) {
          this.opts.onEvent(event);
        }
      } catch (err) {
        Log.trace(
          `[HookEventMonitor] failed to build event for ${file}: ${err}`
        );
      }
    }
  }
}
