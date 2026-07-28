# Secrets and Sensitive-Value Redaction Plan

**Status:** Proposed  
**Priority:** High — before broader remote and automation APIs

## Problem

Workflows can configure MCP environment values, hook commands, scripts, and
variables. Literal credentials in workflow files are unsafe, while resolving a
secret at runtime is only half the problem: the value must also stay out of
logs, persisted run events, previews, exports, errors, and remote dashboard
payloads.

ctrlyoke needs a product-level secret contract before the standalone server,
full MCP control API, or shared workflow/template ecosystem expands.

## Product Decision

Support explicit secret references, never implicit scanning of arbitrary
environment variables:

```yaml
env:
  API_TOKEN: "${secret:service-api-token}"
```

The reference is persisted; the value is resolved only at the execution
boundary. The secret name is not secret, but its value must never be written
back to a workflow or run artifact.

## Phase 1 — Secret store and resolution

- Add a platform-neutral `SecretStore` interface.
- Use VS Code `SecretStorage` in the extension.
- Define an explicit CLI resolution strategy (environment injection or an
  OS-backed credential-store adapter); do not fall back to plaintext config.
- Add commands/UI to set, replace, list names, and delete workspace/user-scoped
  secrets without displaying stored values.
- Restrict interpolation to fields intentionally marked secret-capable, starting
  with MCP/hook/script environment maps.

## Phase 2 — Central redaction pipeline

- Build a per-run redactor from the values actually resolved for that run.
- Apply it before data reaches logs, `events.jsonl`, manifests, notifications,
  error messages, preview output, Markdown export, or dashboard transports.
- Redact common encoded/quoted representations only when deterministic; avoid
  broad heuristics that corrupt normal output.
- Mark redaction in output (`[REDACTED]`) without revealing which secret matched.

## Phase 3 — Authoring and diagnostics

- Flag likely credential literals in secret-capable workflow fields.
- Dry-run preview shows the reference name and `[REDACTED]`, never the value.
- Validation errors identify a missing secret by name and scope.
- Document how secret references behave when workflows are shared or run from
  the CLI.

## Security constraints

- Never include secret values in telemetry.
- Never send a secret to the webview merely to render a settings form.
- Zero secret buffers where practical and avoid retaining resolved workflow
  copies beyond execution.
- Treat user-authored commands as capable of printing secrets; redaction is
  defense in depth, not a sandbox.
- Add tests across failure, retry, cancellation, export, and remote-dashboard
  paths because leaks often occur outside the successful execution path.

## Acceptance criteria

- A shared workflow can reference a credential without containing it.
- Extension and CLI hosts resolve through explicit platform adapters.
- Resolved values are redacted from every persisted and transported output
  surface covered by the test matrix.
- Missing-secret behavior fails before the harness or script starts.
