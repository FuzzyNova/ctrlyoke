# UI Security Review — src/ui (2026-02-27)

**Audit status — last verified 2026-03-07. 2 of 5 recommendations still pending.**

Summary

- Performed a focused manual review of src/ui (webview + React webview assets) for potential security vulnerabilities related to the webview surface and static assets.

High-level findings

1. Webview scripting and CSP

- FlightPathWebviewProvider sets webview.options.enableScripts = true and injects an inline script (acquireVsCodeApi) into the webview HTML. The generated Content-Security-Policy includes 'unsafe-inline' for script-src and style-src (the code replaces the meta tag and inserts `script-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline';`).
- Risk: 'unsafe-inline' permits inline scripts/styles which increases XSS attack surface inside the webview (malicious injected HTML or message handling bugs could lead to code execution). The inline injection of acquireVsCodeApi is required functionally but should be hardened (nonce or hashed inline script) when possible.

2. Surface area: message handling and DOM APIs

- FlightPathWebviewProvider directly switches on message.type in handleWebviewMessage without deep schema validation of message payloads; malformed or malicious message payloads could cause unexpected behavior in code paths that execute commands or filesystem operations.
- The webview React codebase uses DOM-based escaping helper escapeHtml (safe) and CodeMirror editor; a few docs mention innerHTML but runtime code uses proper escaping for user text. Still, any usage of innerHTML or dangerouslySetInnerHTML should be avoided or only used with sanitized content.

3. Third-party/static assets

- Typo.js and dictionaries are loaded from the extension's webview assets (typo.js, en_US.aff/.dic). Third-party script files included in the extension should be audited (no remote network fetch is used for these files, they are local assets which is good).

4. Resource roots and asset URIs

- localResourceRoots are restricted to the built webview bundle and images directory which is good. Static files (codicons, custom-icons.css, dictionaries) are served via webview.asWebviewUri.

Recommendations — implementation status

- [x] DONE — Remove 'unsafe-inline' from script-src. FlightPathWebviewProvider.ts now generates a
      crypto nonce (`crypto.randomBytes(16).toString("hex")`), injects `nonce="${nonce}"` on all script
      tags (including the acquireVsCodeApi inline script and the Vite module bundle), and the CSP is
      `script-src ${webview.cspSource} 'nonce-${nonce}'` with no 'unsafe-inline' for scripts.
- [ ] PENDING — Remove 'unsafe-inline' from style-src. The CSP still contains
      `style-src ${webview.cspSource} 'unsafe-inline'`. Tailwind utility classes and CodeMirror inline
      styles require it for now. To fix: audit whether all dynamic inline styles can be replaced with
      static class names; if so, drop 'unsafe-inline' from style-src entirely.
- [ ] PENDING — Message payload schema validation. WebviewMessageRouter.route() routes by
      message.type via a typed dispatch table (replaces the old switch statement) but the route()
      method signature is `message: any` and individual handlers receive unvalidated payloads. No
      zod/AJV payload schema validation has been added for messages that trigger workspace/filesystem
      operations. Add runtime payload validation for high-impact handlers (e.g., SWITCH_WORKFLOW,
      run/stop commands, file-write paths).
- [x] DONE — innerHTML / dangerouslySetInnerHTML audit. Both usages in MarkdownText.tsx and
      ToolCallOutput.tsx pipe through highlightCode()/highlightLines() from hljsUtils.ts, which is
      highlight.js output. hljs HTML-encodes all user content; the fallback path also manually escapes
      &, <, >. The escapeHtml utility in utils/string.ts uses the textContent→innerHTML DOM pattern,
      which is the correct safe approach. MIGRATION_MAP.md references are documentation-only (not
      runtime code).
- [x] DONE — EndConditionEvaluator script execution is workspace-scoped. Absolute paths are
      checked with `scriptPath.startsWith(workspaceRoot)` and resolved relative paths are similarly
      validated before execution. Unsupported script extensions return an error rather than falling
      through. Configurable timeout is enforced.
- [x] ACCEPTABLE — connect-src is restricted to `${webview.cspSource}` with no broad `https:`
      allowance. No remote network fetches in runtime code outside of webview-local asset URIs.

Files of interest (reviewed)

- src/ui/FlightPathWebviewProvider.ts — webview options, CSP/nonce generation, injected scripts
- src/ui/WebviewMessageRouter.ts — dispatch table replacing the old switch statement
- src/ui/webview-react/index.html — base CSP placeholder and injected script tags
- src/ui/webview-react/static/typo.js — third-party spellchecker bundled locally
- src/ui/webview-react/utils/string.ts — escapeHtml implementation (uses textContent; safe)
- src/ui/webview-react/utils/hljsUtils.ts — highlight.js wrapper; output safe for dangerouslySetInnerHTML
- src/ui/webview-react/components/output/MarkdownText.tsx — dangerouslySetInnerHTML via hljs (safe)
- src/ui/webview-react/components/output/ToolCallOutput.tsx — dangerouslySetInnerHTML via hljs (safe)
- src/ui/webview-react/components/editor/CodeMirrorEditor.tsx — loads dictionaries via fetch from webview URIs
- src/flightpath/EndConditionEvaluator.ts — script execution with workspace-scoped path validation

Conclusion

- No critical remote-execution vectors exist. The primary risk (script-src 'unsafe-inline') has been
  remediated with nonce-based CSP. Two items remain: style-src still uses 'unsafe-inline', and
  message payloads are not schema-validated beyond type routing.

Prepared by: automated review (grep + manual inspection) — recommend a short follow-up security PR implementing CSP nonces and message schema validation.
Last verified: 2026-03-07 (re-audit of all recommendations against current source).
