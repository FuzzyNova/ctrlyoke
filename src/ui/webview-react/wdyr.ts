import React from "react";
import whyDidYouRender, {
  type UpdateInfo,
} from "@welldone-software/why-did-you-render";
import { WebviewLog } from "@utils/logger";

// Vite replaces import.meta.env.DEV with false in production builds,
// causing this block (and the import above) to be tree-shaken out entirely.
if (__WEBVIEW_DEV_MODE__) {
  WebviewLog.debug("[WDYR] why-did-you-render initialized");
  whyDidYouRender(React, {
    trackAllPureComponents: true,
    trackHooks: false, // React 19 changed the dispatcher API; WDYR 10.x crashes on hook patching
    logOnDifferentValues: true,
    notifier(updateInfo: UpdateInfo) {
      const { displayName, reason } = updateInfo;
      const parts: string[] = [];
      if (reason.propsDifferences) parts.push("props");
      if (reason.stateDifferences) parts.push("state");
      WebviewLog.warn(
        `[WDYR] ${displayName} re-rendered because: ${parts.join(", ") || "unknown"}`
      );
      // Also run the default notifier so browser DevTools get the rich grouped output.
      whyDidYouRender.defaultNotifier(updateInfo);
    },
  });
}
