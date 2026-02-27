# UI Security Review — src/ui (2026-02-27)

Summary
- Performed a focused manual review of src/ui (webview + React webview assets) for potential security vulnerabilities related to the webview surface and static assets.

High-level findings
1) Webview scripting and CSP
- FlightPathWebviewProvider sets webview.options.enableScripts = true and injects an inline script (acquireVsCodeApi) into the webview HTML. The generated Content-Security-Policy includes 'unsafe-inline' for script-src and style-src (the code replaces the meta tag and inserts `script-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline';`).
- Risk: 'unsafe-inline' permits inline scripts/styles which increases XSS attack surface inside the webview (malicious injected HTML or message handling bugs could lead to code execution). The inline injection of acquireVsCodeApi is required functionally but should be hardened (nonce or hashed inline script) when possible.

2) Surface area: message handling and DOM APIs
- FlightPathWebviewProvider directly switches on message.type in handleWebviewMessage without deep schema validation of message payloads; malformed or malicious message payloads could cause unexpected behavior in code paths that execute commands or filesystem operations.
- The webview React codebase uses DOM-based escaping helper escapeHtml (safe) and CodeMirror editor; a few docs mention innerHTML but runtime code uses proper escaping for user text. Still, any usage of innerHTML or dangerouslySetInnerHTML should be avoided or only used with sanitized content.

3) Third-party/static assets
- Typo.js and dictionaries are loaded from the extension's webview assets (typo.js, en_US.aff/.dic). Third-party script files included in the extension should be audited (no remote network fetch is used for these files, they are local assets which is good).

4) Resource roots and asset URIs
- localResourceRoots are restricted to the built webview bundle and images directory which is good. Static files (codicons, custom-icons.css, dictionaries) are served via webview.asWebviewUri.

Recommendations (prioritized)
- Remove 'unsafe-inline' from script-src and style-src if possible. Replace inline acquireVsCodeApi injection with a small script using a nonce (generate a nonce in the provider, inject it into the CSP and script tag) or use a script hash so the CSP can remain strict.
- Tighten CSP connect-src: currently allows ${webview.cspSource}; consider restricting connect-src to only what is required (or disallow remote network access entirely unless needed). Avoid including broad https: allowances unless necessary.
- Add strict message validation in FlightPathWebviewProvider.handleWebviewMessage: validate message shape (type is expected constant, payload schema) before executing commands that can affect the workspace or filesystem. Consider using a lightweight runtime schema (zod/AJV) for critical message types.
- Audit any remaining uses of innerHTML / dangerouslySetInnerHTML; prefer using escapeHtml (already present) or React rendering with safe text nodes. Add tests or linters to flag innerHTML usage.
- Audit third-party static files (typo.js) for known vulnerabilities and update/replace if needed.

Files of interest (reviewed)
- src/ui/FlightPathWebviewProvider.ts — webview options, CSP manipulation, injected scripts
- src/ui/webview-react/index.html — base CSP placeholder and injected script tags
- src/ui/webview-react/static/typo.js — third-party spellchecker bundled locally
- src/ui/webview-react/utils/string.ts — escapeHtml implementation (uses textContent; safe)
- src/ui/webview-react/components/editor/CodeMirrorEditor.tsx — loads dictionaries via fetch from webview URIs

Conclusion
- No critical remote-execution vectors were discovered in the local webview assets, however the use of 'unsafe-inline' in CSP and inline script injection increases risk and should be remediated by adopting nonces/hashes and stricter message validation.

Prepared by: automated review (grep + manual inspection) — recommend a short follow-up security PR implementing CSP nonces and message schema validation.
