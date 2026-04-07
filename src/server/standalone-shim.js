(function () {
  "use strict";
  let _state = JSON.parse(sessionStorage.getItem("fpState") || "{}");
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const pending = [];

  ws.addEventListener("open", () => {
    pending.forEach((m) => ws.send(JSON.stringify(m)));
    pending.length = 0;
  });

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);

    // Theme var updates: apply directly to :root without going through React
    if (msg.type === "themeVarsUpdated") {
      const style = document.documentElement.style;
      for (const [k, v] of Object.entries(msg.vars)) style.setProperty(k, v);
      return;
    }

    // All other messages: dispatch to useMessageHandler via window.addEventListener('message', ...)
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  });

  // Reconnect on server restart (development convenience)
  ws.addEventListener("close", () => setTimeout(() => location.reload(), 1500));

  window.vscodeApi = {
    postMessage(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else pending.push(msg);
    },
    getState() { return _state; },
    setState(s) {
      _state = s;
      sessionStorage.setItem("fpState", JSON.stringify(s));
    },
  };
})();
