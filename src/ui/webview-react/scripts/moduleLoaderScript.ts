// Dynamically imports the Vite bundle entry point with a watchdog reload timer.
// __fpModuleSrc__ is injected as a const in the wrapping <script type="module">
// by FlightPathWebviewProvider._getHtmlForWebview before this IIFE runs.
// No imports — compiled as a standalone IIFE.
declare const __fpModuleSrc__: string;

const timeoutMs = 5000;
const recoveryCooldownMs = 10_000;
const recoverySessionKey = "flightpath-panel-module-recovery-at";

const timer = window.setTimeout(function () {
  if (!window.__flightpathReactMounted) {
    const now = Date.now();
    let lastRecoveryAt = 0;
    try {
      lastRecoveryAt = Number(
        sessionStorage.getItem(recoverySessionKey) ?? "0"
      );
    } catch {
      // sessionStorage unavailable
    }
    if (
      !Number.isFinite(lastRecoveryAt) ||
      now - lastRecoveryAt >= recoveryCooldownMs
    ) {
      try {
        sessionStorage.setItem(recoverySessionKey, String(now));
      } catch {
        // sessionStorage unavailable
      }
      window.location.reload();
    }
  }
}, timeoutMs);

void import(__fpModuleSrc__)
  .then(function () {
    window.clearTimeout(timer);
  })
  .catch(function (err: unknown) {
    window.clearTimeout(timer);
    console.error("[FlightPath panel] module bootstrap import failed:", err);
  });
