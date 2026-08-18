# Harness Compatibility and Workflow Portability Plan

> **Status:** The complete Stage 1 / 0.1.0 compatibility gate is shipped, and
> Stage D's CLI validation slice of Phase 2 is complete:
> Phases 1A–1B and Compatibility Phase 1C are complete, as are the permission
> plan's runtime preparation and remaining Antigravity lease stages. Shared
> contracts, the pure effective-property resolver, harness-owned permission
> descriptors, and the backend capability registry have landed in
> [`src/types/CompatibilityTypes.ts`](../../src/types/CompatibilityTypes.ts),
> [`src/types/ExecutionPropertyTypes.ts`](../../src/types/ExecutionPropertyTypes.ts),
> [`src/types/ExecutionPropertyResolver.ts`](../../src/types/ExecutionPropertyResolver.ts),
> and the backend adapter in
> [`src/utils/PropertyResolver.ts`](../../src/utils/PropertyResolver.ts), with
> runtime vocabulary constants in
> [`src/types/DashboardConstants.ts`](../../src/types/DashboardConstants.ts),
> mapper descriptors in the six harness directories, and
> [`src/core/HarnessCapabilityRegistry.ts`](../../src/core/HarnessCapabilityRegistry.ts).
> Phase 1B(i) enables only `permissions`, validates all six harnesses and all
> three permission leaves, caches installed availability/version detection, and
> derives version-aware verification independently per leaf (verified
> 2026-08-01). The shared pure analyzer is wired into workflow validation and
> authoritative execution preflight. The typed `HARNESS_CAPABILITY_SNAPSHOT`
> message, the `useCompatibilityStore` capability-snapshot slice, and the
> `useCompatibilityDiagnostics` render-time hook now provide the same
> installed-version-aware facts and analyzer path to the React dashboard.
> The workflow properties panel and prompt properties drawer now consume those
> facts for persistent, accessible permission diagnostics, mixed-harness
> aggregation, and warning tab indicators without disabling authored values.
> Defaults and advanced permission settings now render the same capability
> summary, and hosted-browser transport parity is covered by the standalone
> shim tests. Customer docs distinguish portable workflow attachments from
> optional harness-native discovery. The dry-run leg and Stage D CLI validation
> of Compatibility Phase 2 have shipped through the shared analyzer and exact
> provider-plan/JSON projections. The workflow portability report and Phase 3
> capability domains remain. MCP capability serialization was cut
> because a context-free snapshot cannot honestly describe whether a workflow
> uses a capability.
>
> **Priority:** P0 — release gate for 0.1.0
>
> **First implementation consumer:**
> [`TOOL_PERMISSION_PARITY_PLAN.md`](../implemented/TOOL_PERMISSION_PARITY_PLAN.md)
>
> **Implementation order:** completed Phase 1 sequencing is recorded in
> [`COMPATIBILITY_AND_FEEDBACK_STAGING.md`](../implemented/COMPATIBILITY_AND_FEEDBACK_STAGING.md);
> remaining Phase 2 and Phase 3 work is sequenced by
> [`FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`](../active/FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md),
> which records the now-satisfied dry-run dependency and the ordered Stage D/G
> implementation seams.
>
> **No dependency on**
> [`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md) — see
> "Toasts are not the authoring surface". The two plans touch disjoint UI:
> compatibility renders persistent field diagnostics and (for blocking
> preflight results) the existing `components/shared/Modal.tsx`; the feedback
> plan builds a transient toast queue. Neither blocks the other in either
> direction.

**Phase 1 only is the 0.1.0 release gate**, together with the permission plan.
Phase 1 is what prevents ctrlyoke from claiming enforcement it does not perform.

Phases 2 and 3 are post-release (decided 2026-07-31). Phase 2 (dry run,
portability report, CLI validation) makes existing truth more visible; it does
not prevent a dishonest support claim or an unsafe workspace mutation, so it
does not gate the release. Its dry-run leg and CLI validation are implemented;
the report remains. Phase 3 adds new capability domains.

Acceptance criteria below that describe dry-run output or the portability
report therefore belong to Phase 2 and are not release gates. Criteria covering
the registry, analyzer, effective-property resolution, authoring diagnostics,
and behavioral permission verification are.

---

## Problem

ctrlyoke presents one workflow model across several AI coding harnesses, but the
harnesses do not implement identical capabilities. Today those differences are
encoded in several disconnected places:

- provider implementations and mappers;
- UI-specific switches such as `getPermissionHarnessSupport()`;
- hook-event metadata;
- warnings written to logs during command construction;
- documentation and marketing caveats;
- `.ctrlyoke/capabilities.json`, which currently reports availability and models
  rather than workflow-feature compatibility.

This means a workflow can look valid in the editor while containing properties
one or more of its effective step harnesses will ignore, approximate, or reject.
The failure or degradation often becomes visible only after execution starts.

That weakens ctrlyoke's central promise: users should be able to switch harnesses
without having to rediscover hidden behavioral differences.

## Product Decision

Create one typed, harness-adapter-owned capability registry and one shared
compatibility analyzer. Every product surface must consume that same model
rather than maintaining its own harness switch.

The layer does **not** pretend the harnesses are identical. It makes differences
explicit, detects lossy translations before execution, and gives provider work a
clear parity backlog.

Only model behavior that can differ between supported harnesses. Do not turn the
registry into an inventory of every workflow field. A ctrlyoke-owned feature
that is deliberately supported for every harness is part of the shared workflow
contract, not a compatibility question.

## Uniform Workflow Features Outside the Registry

The following fields are intentionally portable and must not produce
harness-capability diagnostics.

### Execution mode

Every ctrlyoke harness supports both interactive and headless execution.
`executionMode` is a product invariant for current and future harnesses, not a
provider capability to negotiate. Remove headless/interactive entries from the
capability descriptor, portability report, and version probes.

Provider implementations still need tests for both execution paths. Those are
ordinary harness conformance tests, not capability declarations.

### Sessions

Every ctrlyoke harness provides session identity and supports resuming a
session. Provider-specific session-ID formats, resume flags, and continuation
commands are adapter details behind the shared workflow contract. Remove
session resume/continuation from the capability descriptor, portability report,
and version probes.

As with execution mode, every provider still needs conformance tests proving
that ctrlyoke can capture and resume its sessions. A provider regression is a
bug, not a user-selectable compatibility state.

### Workflow agents and skills

Workflow `agent` and `skills` do not invoke a harness's native agent or skill
selection flags. ctrlyoke resolves the selected files itself, writes their
content to categorized temporary files in
`CliPromptPreparer.createCategorizedPromptFiles()`, and supplies those files as
prompt references. Agent content is wrapped in `<agentInstructions>`; skill
content is attached as the skills category.

This is deliberate. Native mechanisms differ in directory layout, identifier
format, path-versus-name requirements, and feature depth. Using prompt
attachments gives every harness the same workflow-level behavior without
depending on those native conventions.

`AgentSkillsManagerSection.tsx` serves a separate purpose: it can copy/manage
agent and skill files in harness-specific discovery directories so users can
enable native subagent spawning or ambient skill discovery outside ctrlyoke's
explicit workflow attachments. Native discovery does not determine whether a
workflow `agent` or `skills` field is supported.

Required documentation must explain both paths:

- **Workflow attachment:** portable across every harness; ctrlyoke resolves and
  attaches the selected content.
- **Harness-directory discovery:** optional harness-native behavior managed from
  the Agents & Skills settings page; behavior can vary by harness and is not the
  workflow property's execution mechanism.

Do not add `agents`, `skills`, or categorized prompt files to the capability
registry unless ctrlyoke intentionally changes this architecture.

### MCP server injection

Every ctrlyoke harness accepts attached MCP servers. `mcpServers` is therefore a
product invariant like execution mode and sessions, not a capability to
negotiate, and `mcp.injection` was removed from the descriptor on 2026-08-02
before it was ever built.

Per-server tool filtering is a different question and stays modeled — but note
that it is largely _already_ covered by the permission domain rather than being
an independent mechanism. `CliIntegration.mergeServerDeniedTools()` translates a
server's `deniedTools` into ordinary `mcp__<id>__<tool>` deny patterns appended
to `toolPermissions.deniedTools`, so on most harnesses it rides the existing
`permissions.deniedTools` capability. Codex is the exception: it additionally
emits native `disabled_tools` in its generated TOML
(`CodexCliProvider.ts:592`), so it enforces per-server filtering even though its
general granular-list capability is unsupported. Model this domain only if that
asymmetry proves to need its own declaration.

### When a temporary difference becomes invariant

**Usage reporting is now a product invariant and is removed from the registry.**
The required re-audit completed 2026-08-18: `AntigravityUsageProvider` now
participates in the same six-provider `HarnessUsageService`, and Antigravity's
statusline/log parser supplies the normalized turn and context-window data that
was previously missing. Do not ship a compatibility dimension whose entries
are all identical.

## Capability Vocabulary

Every leaf capability declares three orthogonal dimensions.

### Fidelity

- `exact` — ctrlyoke can preserve the requested behavior.
- `partial` — only a documented subset can be preserved.
- `unsupported` — the harness cannot provide the behavior.

### Mechanism

- `native` — the harness directly exposes the ctrlyoke behavior.
- `translated-cli` — ctrlyoke preserves or approximates it through
  harness-specific CLI argument/name translation.
- `workspace-config` — ctrlyoke changes a harness-owned project setting; this
  has workspace-wide side effects.
- `mixed` — the capability requires more than one mechanism.
- `none` — no application mechanism exists.

### Verification

Verification evidence is declared per capability. At analysis time the registry
derives `verified` when the current environment matches that evidence or
`unknown` when the installed version is missing/outside the verified ranges,
the host contract does not match, or evidence is absent.

Do not collapse these dimensions to one enum or boolean. For example, a
capability may be `partial` through `workspace-config`; neither fact can replace
the other. `unsupported` declarations use mechanism `none`, and a supported
fidelity must name a non-`none` mechanism.

`unknown` is only the derived verification status. It does not erase the
declared fidelity or mechanism, so diagnostics can say what ctrlyoke expects to
do and why that expectation is not verified for the current installation.

`mode-only` is not a stored capability value. It is a permission-domain summary
derived from the three independent declarations for `permissions.mode`,
`permissions.allowedTools`, and `permissions.deniedTools`. For example, the UI
may describe a harness as mode-only when its coarse mode has usable fidelity
while both granular-list capabilities are unsupported. If only one list is
supported, a list has partial fidelity, or either list has unknown verification,
the analyzer reports those specific facts instead of forcing them into a
mode-only state.

Diagnostics are based on the configured permission fields that a consumer will
actually use. An empty Allowed Tools list does not create an unsupported-field
warning merely because that capability is absent, while a non-empty Denied
Tools list must be evaluated against `permissions.deniedTools`.

## Capability Contract

Add shared contracts keyed by `HarnessId`. The exact file placement should
follow the existing types/harness-adapter boundaries, but there must be only one
runtime source of truth.

```typescript
type CapabilityFidelity = "exact" | "partial" | "unsupported";
type CapabilityMechanism =
  | "native"
  | "translated-cli"
  | "workspace-config"
  | "mixed"
  | "none";
type CapabilityVerificationStatus = "verified" | "unknown";

interface CapabilityDeclaration {
  fidelity: CapabilityFidelity;
  mechanism: CapabilityMechanism;
  verification?: {
    kind: "behavioral-test" | "manual";
    reference: string;
    basis: "cli-version";
    /** Ranges for which this exact capability claim has evidence. */
    verifiedVersions: HarnessVersionRange[];
  };
  caveatCode?: string;
  remediationCode?: string;
}

interface EffectiveCapabilityState {
  fidelity: CapabilityFidelity;
  mechanism: CapabilityMechanism;
  verification: CapabilityVerificationStatus;
}

type CapabilityDomain = "permissions" | "promptInputs" | "hooks" | "mcp";

interface PermissionCapabilityDescriptor {
  mode: CapabilityDeclaration;
  allowedTools: CapabilityDeclaration;
  deniedTools: CapabilityDeclaration;
}

interface HarnessCapabilityDescriptor {
  harnessId: HarnessId;
  promptInputs?: {
    images: CapabilityDeclaration;
  };
  permissions?: PermissionCapabilityDescriptor;
  hooks?: Partial<Record<HookEvent, CapabilityDeclaration>>;
  mcp?: {
    perServerToolFiltering: CapabilityDeclaration;
  };
}

interface HarnessCapabilityRegistrySnapshot {
  schemaVersion: number;
  enabledDomains: CapabilityDomain[];
  harnesses: Record<HarnessId, InstalledHarnessCapabilities>;
}

interface InstalledHarnessCapabilities {
  available: boolean;
  /** Present for versioned CLI harnesses after detection succeeds. */
  version?: string;
  descriptor: HarnessCapabilityDescriptor;
}
```

Fidelity, mechanism, and verification are intentionally attached to each leaf
declaration, not to a domain or harness-wide `application` field. Permission
mode may use CLI translation while Allowed Tools uses workspace configuration,
and each may have been verified against different versions. A new version can
therefore make one capability unverified without degrading unrelated claims.

Every currently supported harness is a versioned CLI, so `cli-version` is the
only evidence basis this contract needs. If a non-CLI adapter is ever added, add
an explicit versionless evidence basis at that point rather than giving it a
fabricated CLI version or a permanent unknown state; do not add the variant
speculatively now.

`enabledDomains` is the rollout boundary. Phase 1 enables only `permissions`.
An optional domain that is not enabled means **not modeled yet**, not
unsupported or unknown, and the analyzer must not emit diagnostics for it. For
every enabled domain, registry assembly fails its completeness validation if
any `HarnessId` lacks the required declaration. Completeness tests expand one
domain at a time as later phases land.

The registry allows a harness adapter to add stable caveat and remediation
codes, but user-facing prose belongs in shared diagnostic-message helpers rather
than being copied into React components.

### Registry ownership and assembly

The supported harness set is the six CLI harnesses in `HARNESS_IDS`
(`src/types/DashboardConstants.ts`): `copilot-cli`, `claude-cli`, `codex-cli`,
`opencode-cli`, `qwen-cli`, and `antigravity-cli`. The `copilot-chat` harness was
deliberately and permanently removed before release; see
`dev/implemented/COPILOT_CHAT_ARCHIVAL_REMOVAL_PLAN.md`. Do not add a Copilot
Chat descriptor, registry entry, or capability row.

Capability facts belong beside the harness implementation that must keep them
true:

- each CLI harness exports its descriptor from its harness module and exposes it
  through the shared CLI-provider boundary;
- each declaration owns its fidelity, mechanism, version evidence, caveat code,
  and remediation code;
- behavioral tests live with the harness and validate the declaration they
  justify.

One backend `HarnessCapabilityRegistry` assembles these sources. It owns only
cross-harness mechanics:

- the explicit `HarnessId` → capability-source mapping;
- installed availability and version lookup, with version detection cached for
  the application session and refreshed when harness status changes;
- enabled-domain and every-`HarnessId` completeness checks;
- derivation of installed-version-aware effective capability state;
- snapshot schema versioning and serialization for dashboard/MCP consumers.

The explicit mapping is the one permitted central list: it proves that every
supported `HarnessId` has exactly one owner. It must not restate capability
facts in the registry.

The VS Code bridge, CLI, hosted server, and MCP entrypoint obtain snapshots or
queries from this registry. React imports only shared capability/diagnostic
types and receives the serializable snapshot through the existing dashboard
message channel. React must never import a CLI provider, provider factory,
version probe, or backend registry implementation.

## Compatibility Diagnostics

The analyzer accepts a parsed workflow, its resolved properties, the selected
target harness or harnesses, installed harness versions, and workspace state. It
returns structured diagnostics:

```typescript
interface CompatibilityDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  harnessId: HarnessId;
  capability: string;
  /** Definition-level AI target that consumes the resolved value. */
  consumer?: CompatibilityConsumerTarget;
  /** RFC 6901 JSON Pointer to the authored value. */
  propertyPointer?: string;
  sourceTier?: "prompt" | "workflow" | "defaults";
  state: EffectiveCapabilityState;
  message: string;
  remediation?: string;
}

type CompatibilityConsumerTarget =
  | { kind: "queue"; stepIndex: number }
  | { kind: "finalStep" };
```

Use the existing shared constants for target-kind values rather than duplicating
string literals in implementation. This definition-level target intentionally
omits runtime attempt and final-loop indexes: compatibility describes the
workflow field consumed by a step, while runtime history can separately attach
its existing `OutputExecutionTarget` occurrence.

Initial checks:

- each execution target's resolved harness and model availability;
- allowed/denied tool rules and permission modes;
- requested hook events;
- MCP per-server tool filtering;
- image inputs;
- required workspace configuration and its side effects.

Do not warn merely because a harness lacks a native `--agent`/`--skill`
mechanism or uses different discovery directories. Those facts do not affect
ctrlyoke workflow attachments.

Diagnostics must distinguish:

- **invalid** — execution cannot honor the workflow;
- **lossy** — execution can continue, but a field is ignored or approximated;
- **side-effecting** — execution requires a workspace-scoped config mutation;
- **unverified** — the installed version is outside the tested range.

`propertyPointer` identifies where the value was authored using RFC 6901, for
example `/toolPermissions/deniedTools` or `/steps/2/hooks/0/event`. `consumer`
identifies the prompt/final-step execution target whose resolved harness will
consume it. `sourceTier` tells the UI whether that consumer received the value
from its prompt, the workflow, or defaults. Diagnostic identity is the stable
`code` plus structured location fields; consumers must not parse `message`.

Compatibility analyzes effective values per consumer; unlike stale
dropdown-option validation, it must not ignore an inherited security setting
merely because the current drawer does not own it.

### Severity and execution gating

Severity has one consistent meaning on every surface:

| Severity  | Meaning                                                                                                           | Run behavior            |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `error`   | ctrlyoke cannot safely prepare or start this execution target                                                     | Blocks the affected run |
| `warning` | execution can continue, but behavior is ignored, lossy, unverified, or has a disclosed workspace-wide side effect | Does not block          |
| `info`    | portable informational difference with no lost behavior or required user action                                   | Does not block          |

An ignored Allowed Tools or Denied Tools list is a warning, including when the
ignored rule is a denial. It must state plainly that the rule is **not
enforced**, but it does not require confirmation, acknowledgment, or an extra
click before execution. Partial translations and installed versions without
matching capability evidence follow the same non-blocking warning policy.

Only preparation failures become errors—for example an unavailable effective
harness, an invalid required configuration, or a workspace mutation conflict
that the selected writer policy cannot safely resolve. Warnings must remain
visible in authoring, validation, dry-run output, and runtime status/output, but
must not create a modal or confirmation gate. CLI validation fails by default
on errors; its existing optional strict policy may additionally fail on warning
classes for CI without changing interactive run behavior.

## Cross-Harness Resolution Model

A workflow's top-level `harness` is a default, not the harness of every step.
Workflow-level execution properties are also defaults that can be inherited by
steps whose own harness differs.

The analyzer must therefore evaluate execution targets, not compare every
workflow-level property only with the workflow-level harness:

1. enumerate each enabled AI prompt step and an AI `finalStep`;
2. resolve that target's effective harness using the existing
   prompt → workflow → defaults precedence;
3. independently resolve each property using its own inheritance rules;
4. evaluate the resolved property against that target's resolved harness;
5. return target-level diagnostics and aggregate them for the property editor.

Script steps are not AI harness consumers. Dynamically appended prompt steps are
analyzed as soon as they enter the queue; do not guess their future harnesses
before they exist.

An unused workflow-level harness must not create a false warning. For example,
if the workflow default is Codex but every current AI step overrides to Claude,
workflow-level Allowed/Denied Tools are currently consumed only by Claude and
should be reported as supported. If a later dynamic step inherits Codex, the
diagnostic appears when that step is added.

Workflow-level authoring needs aggregate coverage, for example:

> Allowed/Denied Tools: enforced for 6 Claude steps; ignored by 2 Codex steps.

The detailed view lists affected step/final-step names and harnesses. Stable
diagnostic codes remain target-level so CLI/JSON consumers do not have to parse
UI aggregation text.

### Editing remains available

Compatibility never disables a workflow, prompt, or defaults field merely
because one or all current harness consumers cannot honor it. The field may
still apply to other step overrides, future/dynamic steps, a later harness
change, or a copied workflow.

Existing semantic enablement still applies—for example, tool lists can remain
disabled when permission mode itself is not `custom`. Harness compatibility,
however, only annotates the best-effort coverage. It never grays out or prevents
editing the authored value.

**The shipped code violates this rule today.** `getPermissionHarnessSupport()`
returning `"mode-only"` is OR-ed into the `disabled` prop and an
`opacity-50 cursor-not-allowed` class for the Allowed/Denied Tools textareas in
both `WorkflowPropertiesPanel.tsx` and `PropertiesDrawer.tsx`. Phase 1C is
therefore a behavior change, not just a message change: a Codex-default
workflow currently cannot author the lists that its Claude override steps would
enforce. The per-consumer aggregation described below is what makes that field
meaningful again.

### Pure effective-property resolver

Property precedence must remain single-sourced across execution, compatibility
analysis, and the React authoring UI. The current `PropertyResolver`
(`src/utils/PropertyResolver.ts`) combines precedence logic with direct reads
from `ConfigurationUtils` and process-global host state, so it cannot be
imported as the shared browser-safe implementation. Concretely, it calls
`ConfigurationUtils` from roughly nine points inside its resolution methods
(`getIntegrationMode()`, `getDefaultAgent()`, `getModelForHarness()`, and
similar), and it holds a mutable `private static hostCanProvidePty` flag whose
`setHostCanProvidePty()` setter CLI and hosted entrypoints are expected to call
before resolving steps.

This is the highest-risk change in Phase 1A: it is an extraction from a module
on the live execution path, not additive UI work. Land it as its own reviewable
change, behind the conformance fixtures below, before any capability or UI work
depends on it. The static PTY flag in particular must become an explicit
`ExecutionResolutionContext` input — leaving a mutable static behind while
adding a second pure caller would produce two resolvers that disagree depending
on entrypoint startup order.

Extract its resolution rules into a platform-neutral pure function. The exact
type names may follow existing conventions, but the boundary should be
equivalent to:

```typescript
interface ExecutionPropertyDefaults {
  harness: HarnessId;
  modelsByHarness: Partial<Record<HarnessId, string>>;
  additionalArgsByHarness: Partial<Record<HarnessId, string>>;
  // The remaining global/default execution properties.
}

interface ExecutionResolutionContext {
  defaults: ExecutionPropertyDefaults;
  hostCanProvidePty: boolean;
}

interface ResolvedExecutionTarget {
  properties: ResolvedProperties;
  sources: Partial<
    Record<keyof ResolvedProperties, "prompt" | "workflow" | "defaults">
  >;
}

function resolveExecutionProperties(
  prompt: PromptStep,
  workflow: PromptFile,
  context: ExecutionResolutionContext
): ResolvedExecutionTarget;
```

Requirements:

- the pure module must not import `vscode`, `ConfigurationUtils`, Node-only
  modules, provider implementations, or mutable process-global state;
- move any contracts needed by both the pure resolver and React out of
  harness-internal modules and into the existing shared type boundary;
- preserve the current property-specific semantics, including explicit
  `null`/empty resets, per-event hook overrides, harness-specific model and
  additional-argument defaults, and the no-PTY execution-mode clamp;
- make default settings and host capabilities explicit inputs rather than
  reading them inside the resolver;
- return property provenance with the resolved values so compatibility
  diagnostics do not recreate source-tier logic;
- keep `PropertyResolver` as a backend adapter, or replace it with an equivalent
  adapter, that reads `ConfigurationUtils` once, constructs the explicit
  context, and delegates to the pure function;
- have React construct the same context from its settings/capability stores and
  call the same pure function; remove overlapping component-local effective
  property algorithms as each surface migrates;
- have the compatibility analyzer consume `ResolvedExecutionTarget` values. It
  must not implement a second prompt → workflow → defaults resolver.

Table-driven conformance fixtures must run against both the backend adapter and
the pure resolver, covering every property and source tier. Separate React tests
must prove that the same workflow, prompt, defaults, and host-capability inputs
produce the same effective values and provenance used by execution.

## Authoring UX Decision

Compatibility feedback is persistent in-dashboard validation, not a transient
VS Code notification.

It should reuse the visual language already shipped by
[`DROPDOWN_VALIDATION_STYLING_PLAN.md`](../implemented/DROPDOWN_VALIDATION_STYLING_PLAN.md).
The `warning-fg`/`border-warning-fg` token, the `warning?: string` prop on
`CustomSelect`, `MultiCheckboxDropdown`, and `SkillsSelect`, and the shared
border helpers in `src/ui/webview-react/utils/dropdownValidation.ts` all exist
today — this plan consumes them rather than building new styling primitives:

- warning/lossy/unverified: yellow `warning-fg` border, warning icon, and message;
- invalid/error: red input-error border and error text;
- informational/side-effecting: neutral or information treatment without making
  a valid field look broken.

Reuse the styling helpers and existing `warning` props where the affected
control is a `CustomSelect`, `MultiCheckboxDropdown`, or `SkillsSelect`. Do not
put compatibility rules in `dropdownValidation.ts`: that module validates stale
option values in the current environment, while the shared compatibility
analyzer owns provider semantics.

Add a small generic `FieldDiagnostic` renderer and generic validation-border
helper for textareas, editors, and compound controls. The existing hardcoded
mode-only `<p>` blocks in `WorkflowPropertiesPanel.tsx` and
`PropertiesDrawer.tsx` should be replaced by structured diagnostics from the
analyzer. Controls reference their messages with `aria-describedby`; newly
appearing summary feedback uses a polite live region.

### Two levels of feedback

1. **Compact summary near the harness control**
   - Example: `2 compatibility warnings for Antigravity CLI`.
   - Selecting **Review** opens/jumps to the first affected property.
   - The harness dropdown itself is not marked invalid merely because another
     property is incompatible.
2. **Persistent field-level diagnostics**
   - Highlight the affected controls.
   - State exactly what is ignored, approximated, or workspace-scoped.
   - Preserve configured values when switching harnesses; never clear them as a
     side effect.
   - Keep controls editable regardless of harness compatibility.
   - For workflow-level fields, summarize supported and unsupported consumers
     instead of treating the workflow default harness as the only target.

Do not render only a colored border. Color without adjacent explanatory text,
an icon, and an accessible association is insufficient.

### Required mixed-harness permission interaction

Given a workflow with:

- workflow harness `codex-cli`;
- permission mode `custom`;
- non-empty Allowed Tools and/or Denied Tools;
- most prompt steps overriding their harness to `claude-cli`;
- one or more prompt/final steps inheriting the workflow's Codex harness;

the authoring UI must show:

1. Allowed Tools and Denied Tools remain editable at workflow level;
2. Claude override steps are counted as supported consumers;
3. Codex-inheriting steps are counted as mode-only consumers;
4. the Permissions page/tab receives a warning indicator because coverage is
   mixed;
5. the field diagnostic states, for example:

   > Enforced for 5 Claude steps. Ignored by 2 Codex steps because Codex uses
   > sandbox/approval modes instead of individual tool patterns.

6. each affected Codex prompt drawer shows its effective warning and identifies
   the workflow as the property source;
7. Claude prompt drawers do not show a false incompatibility warning.

If the workflow harness then changes from Codex to Antigravity, only targets
that inherit the workflow harness are re-evaluated. Claude overrides remain
supported and unchanged. The updated aggregate names Antigravity for the
inheriting targets and explains that its coarse permission mode does not enforce
the lists.

The warning is informational about pending execution. It does not mutate the
workflow, automatically change permission mode, disable authoring, or launch a
harness.

### Toasts are not the authoring surface

Do not show a toast every time the harness changes. Toasts disappear, are easy
to miss, create noise while comparing harnesses, and cannot explain several
affected fields. Persistent summary and field messages are the source of truth.

The compatibility feature does not require a new toast system and must not call
`vscode.window.showInformationMessage`, `showWarningMessage`, or
`showErrorMessage`.

There is a separate platform-parity gap worth its own audit:

- backend code still contains many direct VS Code notification calls;
- `uiStore` contains in-app toast state and roughly twenty call sites populate
  it, but the React application still has no mounted toast renderer
  (re-verified 2026-08-01);
- [`DROPDOWN_VALIDATION_STYLING_PLAN.md`](../implemented/DROPDOWN_VALIDATION_STYLING_PLAN.md)
  already identifies a broader runtime diagnostics gap.

That gap is now specified as
[`BROWSER_USER_FEEDBACK_PLAN.md`](BROWSER_USER_FEEDBACK_PLAN.md), and it is
**not** a prerequisite for author-time compatibility. Everything this plan
renders already exists: `CustomSelect`/`MultiCheckboxDropdown`/`SkillsSelect`
accept a `warning` prop, `utils/dropdownValidation.ts` exports
`dropdownBorderClass`/`dropdownWarningClass`, and
`components/shared/Modal.tsx` is the shared blocking-result primitive for both
hosts. Do not sequence this plan behind the toast work. Runtime compatibility
warnings should use the existing dashboard status/output message path until a
broader diagnostics surface replaces it. Any warning that requires a user
choice must use a shared React modal so hosted-browser users can respond; a
VS Code-only notification action is not sufficient.

A blocking preflight error is different from a warning that asks for a choice.
When a user explicitly attempts to run and preparation fails, the dashboard may
show a shared React result modal with no unsafe override, while also persisting
the diagnostic in status/output. The workspace-permission conflict behavior is
defined in `TOOL_PERMISSION_PARITY_PLAN.md`. This does not depend on toast
unification and must work identically in the VS Code webview and hosted browser.

Note that permission-policy leases are **step-scoped**, not workflow-scoped (see
that plan's "Decided semantics"). A conflict can therefore surface mid-run, not
only at start, and the same blocking-result treatment applies at that step.

## Product Surfaces

### Workflow and prompt authoring

- Render the summary and field diagnostics defined above.
- Show a compact portability summary aggregated over all current effective AI
  harness consumers, including inherited incompatible values.
- When changing harnesses, immediately recalculate warnings without waiting for
  a save, file reload, server round trip, or execution.
- When changing a step override, update both that prompt's diagnostics and the
  workflow-level aggregate.
- Keep fields editable while making unsupported consumers explicit.

### Workflow-level portability report

Add a report that can evaluate one workflow against every installed harness:

| Harness | Ready | Lossy | Unsupported | Workspace side effects |
| ------- | ----- | ----- | ----------- | ---------------------- |

Selecting a row reveals step/property-level findings and remediations.

### Dry-run preview

The dry-run result must include compatibility diagnostics and the provider
translation that will actually be applied. Preview is the final pre-execution
truth surface, not a second capability implementation.

### CLI and automation

Extend validation with an optional target harness:

```text
ctrlyoke validate workflow.ctrlyoke.yaml --harness qwen-cli
ctrlyoke validate workflow.ctrlyoke.yaml --all-installed-harnesses --json
```

Use stable diagnostic codes and structured JSON. CI must be able to fail on
errors and optionally on lossy or unverified behavior. Stage D implements this
as `--strict lossy`, `--strict unverified`, or `--strict all`; parse-only
validation remains the default, and JSON output uses a one-line v1 envelope.

### MCP capabilities

No capability serialization is added to `.ctrlyoke/capabilities.json`. A static
per-harness snapshot is context-free and cannot say whether the current
workflow actually uses a field, so it can turn an honest analyzer result into a
misleading support claim. The file retains its existing availability/model data
and existence-validation role; external workflow compatibility remains a
validation/report concern.

## Browser and Hosted-Server Parity

The VS Code panel and hosted browser use the same React dashboard, so
compatibility presentation belongs there. `CtrlYokeHostedServer` already
forwards dashboard messages over its WebSocket and serves the same compiled
client; it should not implement a second compatibility analyzer or browser-only
warning path.

To keep feedback both immediate and single-sourced:

1. The backend registry publishes a typed, installed-version-aware capability
   snapshot on client `READY` and whenever harness availability or detected
   version changes.
2. The React store caches that snapshot.
3. One shared pure compatibility analyzer is compiled for backend validation
   and the React client. A `useCompatibilityDiagnostics` hook evaluates the
   current effective properties against the cached snapshot during render.
4. Backend validation, dry run, CLI validation, and execution preflight run the
   same analyzer authoritatively; the client is an immediate projection, not a
   separate rule set.

Harness facts remain harness-adapter-owned. React components must not recreate a
hardcoded harness switch. The serialized snapshot contains data, not
harness-specific user-facing prose.

Both analyzer paths also use the pure effective-property resolver defined
above. The backend supplies defaults through its configuration adapter; React
supplies the equivalent defaults from its synchronized settings store. A
capability snapshot transports harness facts, not an independently resolved
copy of the workflow.

Hosted acceptance tests must connect through the standalone shim/WebSocket,
receive the capability snapshot, change the harness, and observe the same
diagnostic codes and UI state as the VS Code webview. No compatibility
requirement may depend on importing `vscode` into the server or React bundle.

## Version Awareness

Harness CLIs evolve independently. A mapper unit test proves only that ctrlyoke
emits an argument; it does not prove that an installed CLI accepts or enforces
it.

- Record evidence and verified version ranges on each nontrivial leaf
  capability, never once for the whole harness.
- Resolve each declaration independently against the installed version. Treat a
  missing version, a version outside that capability's ranges, or missing
  evidence as verification `unknown`, not silently `verified`; preserve the
  declaration's separate fidelity and mechanism.
- Add a harness-owned probe where the CLI exposes machine-readable capabilities.
- Do not parse human-readable `--help` output at normal runtime unless no stable
  interface exists; it can remain an integration-test oracle.
- Cache each CLI version once per application session and publish it with the
  capability snapshot. Invalidate that entry when harness availability is
  refreshed or the executable changes.
- While the initial snapshot/version probe is pending, React shows a neutral
  checking state and emits no speculative compatibility warning.
- An unavailable harness is an error only for an actual execution consumer.
  An available harness with a missing/out-of-range version produces
  non-blocking unverified warnings only for the affected capabilities.

Version tracking applies only to non-uniform behavior in the registry. It must
not make workflow agents, workflow skills, execution mode, or session resume
appear conditionally supported because a native harness feature changed.

## Sandbox Boundary — Deferred

Sandbox policy is not yet a portable workflow field:

- `schemas/settings-schema.json` exposes
  `permissions.codexSandboxMode` and `permissions.codexApprovalPolicy` as
  Codex-specific global/workspace settings.
- `schemas/workflow-schema.json` has no sandbox property.
- `CodexCliProvider` reads the Codex settings directly while preparing
  permission arguments rather than receiving a resolved workflow property.
- Antigravity maps custom permission mode to a boolean `--sandbox` flag; this is
  not the same profile vocabulary as Codex's `read-only`, `workspace-write`,
  and `danger-full-access`.

Do not simply move or rename the Codex enum in the workflow schema. A portable
sandbox design must first decide:

- the harness-neutral policy vocabulary and whether it describes filesystem,
  network, process, or combined isolation;
- global/workflow/prompt inheritance and explicit reset behavior;
- interaction and conflict rules with `toolPermissions.mode`, especially
  `dangerouslyAllowAll`, `allowAll`, `custom`, and passthrough;
- the fidelity of each harness mapping and whether its mechanism is native, CLI
  translation, workspace configuration, mixed, or none;
- interactive/headless differences in accepted flags;
- migration and deprecation of the existing Codex-specific settings;
- diagnostics when a requested isolation level cannot be enforced.

Do not create or schedule a separate sandbox plan yet. If sandbox portability
becomes a priority, first write the focused design for the questions above;
then let the compatibility registry consume the resulting capability and
surface lossy/unsupported translations. This plan should not invent the
portable policy contract or fold sandbox work into the granular
allowed/denied-tool vertical slice.

## Architecture Rules

- Harness-adapter declarations own facts; UI components only render them.
- The compatibility analyzer must remain platform-neutral so the VS Code
  extension, standalone CLI, hosted dashboard, and MCP entrypoint agree.
- Capability metadata does not replace actual provider validation. Command
  builders and workspace-config writers still reject unsafe or impossible
  translations.
- Warnings emitted during execution must reuse the same diagnostic codes/messages
  shown before execution.
- A capability declaration cannot claim `exact` or `partial` fidelity without a
  behavioral integration test or an explicitly recorded manual verification.
- Marketing documentation should describe the shared workflow surface and link
  to a generated/current compatibility table rather than hand-maintaining parity
  claims.
- Documentation must describe workflow agents/skills as ctrlyoke prompt
  attachments and distinguish them from optional harness-native discovery.

## Phases

### Phase 1 — Registry and permission vertical slice

This phase is ordered internally. Do not implement the permission UI against a
temporary harness switch while waiting for the registry.

#### Phase 1A — Shared contracts and effective resolution

- Add the orthogonal fidelity/mechanism/verification vocabulary and structured
  diagnostic contracts.
- Extract the browser-safe effective-property resolver, make configuration and
  host capabilities explicit inputs, and route the existing backend resolver
  through it.

#### Phase 1B — Permission registry and analyzer

- Add harness-adapter-owned permission descriptors and central registry
  assembly.
- Enable only the permission domain and enforce completeness for that domain
  across every `HarnessId`; leave later domains explicitly unmodeled.
- Add capability-specific verification evidence, cached version detection, and
  neutral pending-snapshot behavior.
- Add the shared pure analyzer and expose its findings through workflow
  validation and authoritative execution preflight.
- Add the typed client capability-snapshot message and React store.

#### Phase 1C — Permission honesty in every authoring surface

- Migrate permission support out of
  `components/shared/permissionUtils.ts`.
- Add `FieldDiagnostic`, summary treatment, page/tab warning indicators, and
  generic validation styling for non-dropdown controls.
- Implement instant tool-permission diagnostics in both property editors and
  defaults, including effective inherited values and cross-harness workflow
  aggregation.
- Replace the hardcoded mode-only permission paragraphs with structured
  diagnostics.
- Verify mixed Codex-default/Claude-override behavior and a subsequent
  Codex-to-Antigravity default change in both the VS Code webview and a
  hosted-browser client.
- Complete the authoring work labeled Compatibility Phase 1C in
  `TOOL_PERMISSION_PARITY_PLAN.md`; do not retain or add a fallback harness
  switch after this stage.

After Phase 1C, continue with the permission plan in this order:

1. evolve the runtime permission-preparation contract;
2. implement the shared workspace-policy lease/writer and blocking-conflict UX;
3. implement and behaviorally verify Qwen;
4. implement OpenCode and coordinate its writes with the existing MCP writer.

### Phase 2 — Validation and complete workflow report

> **Post-release (P1).** Not a 0.1.0 gate — see the status note at the top of
> this plan.

Begin this phase after the permission plan's Qwen/OpenCode preparation paths
exist, so preview reports the actual translation and side effects rather than a
second speculative implementation.

- **Done:** integrate the Phase 1 shared analyzer and exact provider translation
  with dry-run preview.
- **Done 2026-08-18:** integrate the Phase 1 shared analyzer with CLI validation,
  including selected/all-installed targets, strict CI policies, and JSON v1.
- Add the installed-harness portability report.

### Phase 3 — Expand capability domains

- Hooks and notifications.
- MCP per-server tool filtering, if the Codex asymmetry above proves to need its
  own declaration. Injection is uniform and is not modeled.
- Image prompt inputs.
- Generate customer-facing compatibility documentation from the registry.
- Extend the tab warning-badge overlay to every domain enabled in this phase.

The usage re-audit is complete and removed that uniform domain; see "When a
temporary difference becomes invariant" above.

#### Tab warning badges

**The governing rule — two channels, not one.** A navigation tab's **primary
icon, meaning both its glyph and its color, carries state**; its **overlay badge
carries diagnostics, and diagnostics only**. `permissionModeIconOverride()`
changes both halves of the primary icon for `dangerouslyAllowAll` (a
`workspace-untrusted` glyph in `text-error-fg`), and that is correct — a risky
mode is still state, and the icon is where state belongs. The badge is reserved
for errors and warnings so that a badge always means "something needs attention."
Do not add a badge to indicate that a feature is merely configured or enabled;
that is what the icon channel is for, and a state badge would compete with a
diagnostic for the single slot each tab has.

Note one pre-existing exception: `getPermissionModeBadge()` returns a shield
badge for permission mode on the Command tab of `DryRunModal`. It lives in a
modal's internal tab bar rather than the drawer navigation, and it encodes risk
level rather than plain configuration. Do not cite it as precedent for state
badges on drawer tabs.

A tab whose primary icon is a brand image has **no state channel at all** and
therefore takes neither treatment. The Harness tab renders `HarnessIcon`, an
`<img>` with a base64 data URI: `TabIconOverride.color` is a silent no-op against
it, and swapping its glyph would destroy the identity the tab exists to display.
Two rules follow. First, the Harness tab may only ever receive
`badgeCodicon`/`badgeColor`; supplying `codicon` would make `SegmentedTabBar`'s
`override?.codicon ?? tab.codicon` resolution take the codicon branch and replace
the brand logo with a generic glyph. Second, the badge overlay currently renders
only inside that codicon branch, so the `HarnessIcon` branch has no badge slot —
and per the dead-plumbing rule at the end of this section, none should be added
until a harness-level capability domain actually produces a diagnostic to show
there.

The Permissions tab already overlays a diagnostic-driven warning badge on its
existing icon: `getPermissionTabOverride()` in
[`tabBadgeUtils.ts`](../../src/ui/webview-react/components/shared/tabBadgeUtils.ts)
takes a `hasCompatibilityWarning` flag and, when true, adds
`badgeCodicon: "warning"` / `badgeColor: "text-warning-fg"` on top of the
mode's own icon and color rather than replacing them — the permission state
must stay legible even while flagging a compatibility issue. This is the only
tab today with diagnostic-driven badge logic, because `permissions` is
currently the only enabled capability domain; the other tab-override
functions in that file (`getHooksTabOverride`, `getMcpTabOverride`,
`getValidationTabOverride`, `getContextTabOverride`) are "something
non-default is configured" indicators, not warning/error indicators, and
take no diagnostics input.

As each Phase 3 domain is enabled, give its corresponding tab the same
overlay-badge treatment instead of inventing a new visual language:

- **Hooks** — once the `hooks` domain is enabled, `getHooksTabOverride` needs
  a diagnostics input (or a sibling warning-badge helper) so a hook-event
  compatibility warning overlays a badge on the tab's existing configured-icon
  state, the same way permission mode and warning coexist today.
- **MCP** — once per-server tool filtering (or another MCP capability) is
  modeled, `getMcpTabOverride` needs the equivalent overlay for a filtering
  warning, without losing the existing "servers configured" indicator.
- **Images** — if image inputs become a tab-scoped domain with their own
  authoring surface, give that surface the same warning-badge overlay rather
  than a bespoke treatment.

Do not replace a tab's base icon/color to signal a compatibility warning; add
the badge overlay on top, consistent with the Permissions tab precedent. Do
not build the diagnostics parameter for a tab before that tab's capability
domain is actually enabled — until then there is no diagnostic data to badge,
and the parameter would be dead plumbing. The same restraint applies to badge
rendering itself: do not add a badge slot to a tab that has no diagnostic
consumer yet.

This section is the single source for tab-indicator conventions. Other plans
that add drawer-tab state should follow it rather than restating it; see
`dev/backlog/WORKTREE_SUPPORT_PLAN.md`, where worktree state is deliberately
routed to `WorkflowStatus` and `RunSummaryBanner` instead of a tab badge.

## Acceptance Criteria

- No React component contains a hardcoded harness list for permission support.
- React does not import CLI providers, provider factories, version probes, or the
  backend registry implementation.
- `mode-only` is never stored in a capability declaration; permission summaries
  are derived from the separate mode, Allowed Tools, and Denied Tools
  capabilities.
- Fidelity, mechanism, and verification remain independent through registry
  serialization and diagnostics; no domain-level application enum or combined
  support state may replace them.
- Ignored permission lists, including Denied Tools, are clear non-blocking
  warnings and never require confirmation or acknowledgment.
- Every diagnostic uses a structured consumer target and RFC 6901 property
  pointer; no consumer parses display prose to identify a field or step.
- Execution, backend validation, and React compatibility analysis use one pure
  effective-property resolver with explicit defaults and host capabilities.
- Resolution conformance tests cover every property/source tier and prove that
  browser and backend callers receive identical values and provenance.
- Changing a workflow default or prompt override harness updates only the
  affected consumer diagnostics immediately, without a save/reload/server round
  trip.
- The authoring UI shows both a compact summary and persistent, accessible
  field-level explanations; it never relies on border color or a toast alone.
- A Codex-default workflow with Claude override steps reports permission-list
  support per effective consumer rather than classifying the whole workflow as
  Codex.
- Compatibility never disables workflow/prompt/default property editing; it
  preserves values and reports best-effort coverage.
- Inherited incompatible values are disclosed at the effective prompt/workflow
  surface and identify their source tier.
- CLI validation and dashboard validation return the same diagnostic codes.
- Dry run shows every lossy translation and workspace-scoped side effect.
- Installed versions outside each capability's own verified ranges are
  identified as unverified without degrading independently verified
  capabilities.
- The registry is covered by a completeness test for every `HarnessId` in each
  enabled domain; unmodeled domains emit no diagnostics.
- At least the permission domain has behavioral tests that prove restrictions are
  enforced, not merely that arguments/config files were generated.
- Execution mode, session resume, workflow agents, and workflow skills do not
  appear as conditional support in the registry or portability report.
- Customer documentation clearly distinguishes portable workflow
  agent/skill attachment from optional harness-native discovery.
- Hosted browser and VS Code webview clients render the same compatibility
  diagnostics from the same capability snapshot and analyzer.
- Author-time compatibility works without any
  `vscode.window.show*Message` call or a new toast implementation.

## Non-goals

- Identical behavior from every harness.
- Blocking all execution merely because a translation is lossy.
- Automatically changing a workflow when its harness changes.
- Scraping release notes or remotely downloading capability definitions at
  runtime.
- Adding another harness before the existing compatibility model is trustworthy.
- Selecting native harness agents or skills with provider-specific CLI flags.
- Defining the portable sandbox schema before its policy and conflict semantics
  are designed.
- Creating a sandbox portability plan before that work is prioritized.
