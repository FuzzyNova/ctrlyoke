---
applyTo: "src/types/**"
---

<scope>
`src/types/` is the shared contract layer between core workflow code, harness integrations, the VS Code/webview boundary, and the hosted server. Keep these files focused on cross-subsystem contracts and runtime constants that truly need one canonical definition.
</scope>

<rules>
- Prefer adding shared discriminants and string literals to `DashboardConstants.ts`; consumers should import helper union types from there instead of re-declaring raw strings.
- Keep type modules runtime-light. Adding runtime helpers here is only appropriate when both sides of a boundary need the same value at runtime (for example constants or schema/version markers).
- Do not flatten inheritance semantics out of the shared contracts: in execution/config types, `null` usually means “explicitly disable inherited value” while `undefined` means “inherit/default”.
- When you add or change a shared contract here, update the owning runtime code in the same change (`PromptFileParser`, `PropertyResolver`, webview message router/provider, history/timeline projection, config service, etc.). These files are consumed widely, so stale types are worse than missing types.
</rules>

<subareas>
See the narrower companion instruction files for the important gotchas by sub-area:

- `types-core.instructions.md` — workflow/core/shared runtime contracts
- `types-webview-history.instructions.md` — webview message contracts plus history/timeline types
- `types-hosted.instructions.md` — hosted workspace viewer and generated icon defaults
  </subareas>
