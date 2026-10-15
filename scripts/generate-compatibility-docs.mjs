#!/usr/bin/env node

/**
 * Generate the customer-facing harness compatibility matrix.
 *
 * The declarations come from the compiled HarnessCapabilityRegistry seam. The
 * script never parses TypeScript or keeps a second harness/capability table.
 *
 * Usage:
 *   npm run generate-compatibility-docs
 *   npm run check:compatibility-docs
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const OUTPUT_PATH = resolve(ROOT_DIR, "docs/harnesses/compatibility.md");
const COMPILED_REGISTRY_PATH = resolve(
  ROOT_DIR,
  "out/core/HarnessCapabilityRegistry.js"
);
const require = createRequire(import.meta.url);
const CHECK_MODE = process.argv.includes("--check");

// `aside: false` drops the right-hand outline so the seven-column matrix gets
// the full content width.
const FRONTMATTER = `---
description: "Which workflow capabilities each harness supports, generated from the harness compatibility registry."
editLink: false
aside: false
---`;

const GENERATED_HEADER =
  "<!-- AUTO-GENERATED — run `npm run generate-compatibility-docs` to update -->";

/** @typedef {{ fidelity: string, mechanism: string, verification?: { kind: string, reference: string, basis: string, verifiedVersions: string[] }, caveatCode?: string }} CapabilityDeclaration */

export function installVscodeStub() {
  // Provider construction is the existing registry's static, no-I/O seam, but
  // its compiled dependency graph also contains VS Code-only utility imports.
  // Keep the docs generator portable by supplying a host-neutral module while
  // declarations are read; no provider execution method is called here.
  const Module = require("node:module");
  const originalLoad = Module._load;
  function callableTarget() {
    return undefined;
  }
  const callable = new Proxy(callableTarget, {
    apply: () => undefined,
    construct: () => ({}),
    get: () => callable,
  });
  const vscodeStub = new Proxy(
    {},
    {
      get: (_target, property) => (property === "__esModule" ? true : callable),
    }
  );

  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return vscodeStub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    Module._load = originalLoad;
  };
}

export function loadDocumentationFacts() {
  if (!existsSync(COMPILED_REGISTRY_PATH)) {
    throw new Error(
      `Compiled registry not found at ${COMPILED_REGISTRY_PATH}. Run "npm run compile-tests" first.`
    );
  }

  const restoreVscodeLoader = installVscodeStub();
  try {
    const { HarnessCapabilityRegistry } = require(COMPILED_REGISTRY_PATH);
    return HarnessCapabilityRegistry.getDocumentationFacts();
  } finally {
    restoreVscodeLoader();
  }
}

/**
 * The compiled compatibility prose helpers plus the fidelity constants the
 * matrix keys its symbols on.
 */
export function loadCompatibilityTypes() {
  return {
    ...require(resolve(ROOT_DIR, "out/types/CompatibilityTypes.js")),
    fidelities: require(resolve(ROOT_DIR, "out/types/DashboardConstants.js"))
      .CAPABILITY_FIDELITIES,
  };
}

function isCapabilityDeclaration(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.fidelity === "string" &&
    typeof value.mechanism === "string"
  );
}

function collectLeaves(value, prefix = "") {
  if (isCapabilityDeclaration(value)) {
    return [{ capability: prefix, declaration: value }];
  }
  return Object.entries(value ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, child]) =>
      collectLeaves(child, prefix ? `${prefix}.${key}` : key)
    );
}

function formatLabel(value) {
  return value
    .split(".")
    .map((part) =>
      part
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/^mcp$/i, "MCP")
        .replace(/^./, (character) => character.toUpperCase())
    )
    .join(" / ");
}

function formatReference(reference) {
  if (/^https?:\/\//.test(reference)) {
    return reference;
  }
  return `https://github.com/FuzzyNova/ctrlyoke/blob/main/${reference}`;
}

/**
 * A verification's evidence label, linked to its reference. Internal `dev/`
 * plans are maintainer records, not reader documentation, so their evidence
 * is named without a link.
 */
function formatEvidence({ kind, reference }) {
  return reference.startsWith("dev/")
    ? kind
    : `[${kind}](${formatReference(reference)})`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function tableRow(cells) {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function tableDivider(columnCount, divider) {
  return `| --- | ${Array(columnCount).fill(divider).join(" | ")} |`;
}

/** "GitHub Copilot CLI" → "Copilot": every harness here is a CLI. */
function shortHarnessName(displayName) {
  return displayName.replace(/^GitHub\s+/, "").replace(/\s+CLI$/, "");
}

function harnessHeader({ harnessId, displayName }) {
  return `[${shortHarnessName(displayName)}](/harnesses/${harnessId})<br>\`${harnessId}\``;
}

/**
 * Ordered union of capability leaves for one domain across every harness, so
 * a capability one harness omits still gets a row (rendered as a gap).
 */
function collectDomainCapabilities(facts, domain) {
  const capabilities = [];
  for (const harness of facts.harnesses) {
    for (const { capability } of collectLeaves(harness.capabilities[domain])) {
      if (!capabilities.includes(capability)) {
        capabilities.push(capability);
      }
    }
  }
  return capabilities;
}

function getDeclaration(harness, domain, capability) {
  return capability
    .split(".")
    .reduce((node, key) => node?.[key], harness.capabilities[domain]);
}

function cellKey(harness, domain, capability) {
  return `${harness.harnessId}|${domain}|${capability}`;
}

function fidelityPresentation(fidelities) {
  return {
    [fidelities.EXACT]: { symbol: "✅", status: "Supported" },
    [fidelities.PARTIAL]: { symbol: "◐", status: "Partially supported" },
    [fidelities.UNSUPPORTED]: { symbol: "❌", status: "Not supported" },
  };
}

function presentFidelity(presentation, fidelity) {
  const entry = presentation[fidelity];
  if (!entry) {
    throw new Error(`No matrix symbol for capability fidelity "${fidelity}".`);
  }
  return entry;
}

/** Visit every declared matrix cell in display order. */
function forEachCell(facts, visit) {
  for (const domain of facts.enabledDomains) {
    for (const capability of collectDomainCapabilities(facts, domain)) {
      for (const harness of facts.harnesses) {
        const declaration = getDeclaration(harness, domain, capability);
        if (declaration) {
          visit({ harness, domain, capability, declaration });
        }
      }
    }
  }
}

/**
 * Assign one footnote per distinct explanation, numbered in matrix order, so
 * identical caveat/remediation prose is printed once with every
 * harness/capability it applies to listed under it.
 */
function buildNotes(facts, compatibilityTypes, presentation) {
  const notes = [];
  const noteByCell = new Map();
  forEachCell(facts, ({ harness, domain, capability, declaration }) => {
    if (declaration.fidelity === compatibilityTypes.fidelities.EXACT) {
      return;
    }
    const caveat = compatibilityTypes.getCompatibilityCaveatMessage(
      declaration.caveatCode
    );
    const remediation =
      compatibilityTypes.getCompatibilityDeclarationRemediation(
        domain,
        capability,
        declaration
      );
    const { status } = presentFidelity(presentation, declaration.fidelity);
    // Advisory caveats add a note to enforced support; reason caveats explain
    // why the capability is limited.
    const explanation = caveat
      ? `${status}${compatibilityTypes.isAdvisoryCaveat(declaration.caveatCode) ? `: ${caveat}` : ` ${caveat}`}.`
      : `${status}.`;
    const key = `${explanation}\n${remediation ?? ""}`;
    let note = notes.find((candidate) => candidate.key === key);
    if (!note) {
      note = {
        key,
        number: notes.length + 1,
        explanation,
        remediation,
        appliesTo: new Map(),
      };
      notes.push(note);
    }
    const harnessName = shortHarnessName(harness.displayName);
    note.appliesTo.set(harnessName, [
      ...(note.appliesTo.get(harnessName) ?? []),
      formatLabel(capability),
    ]);
    noteByCell.set(cellKey(harness, domain, capability), note);
  });
  return { notes, noteByCell };
}

function noteAnchor(note) {
  return `note-${note.number}`;
}

/** Capability rows grouped under bold domain rows, one column per harness. */
function buildPivotTable(facts, firstColumnHeader, harnessHeaders, renderCell) {
  const lines = [
    tableRow([firstColumnHeader, ...harnessHeaders]),
    tableDivider(facts.harnesses.length, ":-:"),
  ];
  for (const domain of facts.enabledDomains) {
    lines.push(
      tableRow([`**${formatLabel(domain)}**`, ...facts.harnesses.map(() => "")])
    );
    for (const capability of collectDomainCapabilities(facts, domain)) {
      lines.push(
        tableRow([
          formatLabel(capability),
          ...facts.harnesses.map((harness) => {
            const declaration = getDeclaration(harness, domain, capability);
            return declaration
              ? renderCell(harness, domain, capability, declaration)
              : "—";
          }),
        ])
      );
    }
  }
  return lines.join("\n");
}

function buildMatrix(facts, presentation, noteByCell) {
  return buildPivotTable(
    facts,
    "Capability",
    facts.harnesses.map(harnessHeader),
    (harness, domain, capability, declaration) => {
      const { symbol, status } = presentFidelity(
        presentation,
        declaration.fidelity
      );
      const note = noteByCell.get(cellKey(harness, domain, capability));
      const marker = note
        ? `<sup><a href="#${noteAnchor(note)}">${note.number}</a></sup>`
        : "";
      return `<span title="${status}">${symbol}</span>${marker}`;
    }
  );
}

function buildMechanismTable(facts) {
  return buildPivotTable(
    facts,
    "Capability",
    facts.harnesses.map(({ displayName }) => shortHarnessName(displayName)),
    (_harness, _domain, _capability, declaration) => declaration.mechanism
  );
}

function buildNotesSection(facts, notes) {
  const harnessOrder = facts.harnesses.map(({ displayName }) =>
    shortHarnessName(displayName)
  );
  return notes
    .map((note) => {
      const appliesTo = [...note.appliesTo]
        .sort(
          ([left], [right]) =>
            harnessOrder.indexOf(left) - harnessOrder.indexOf(right)
        )
        .map(
          ([harnessName, labels]) => `**${harnessName}**: ${labels.join(", ")}`
        )
        .join(" · ");
      const remediation = note.remediation
        ? ` _What to do:_ ${note.remediation}`
        : "";
      return `<a id="${noteAnchor(note)}"></a>**${note.number}.** ${note.explanation}${remediation}<br>\nApplies to ${appliesTo}.`;
    })
    .join("\n\n");
}

/** Distinct "version range (evidence)" claims one harness makes in a domain. */
function formatDomainEvidence(harness, domain) {
  const claims = [];
  for (const { declaration } of collectLeaves(harness.capabilities[domain])) {
    const verification = declaration.verification;
    if (!verification) {
      continue;
    }
    const claim = `${verification.verifiedVersions.join(", ")} (${formatEvidence(verification)})`;
    if (!claims.includes(claim)) {
      claims.push(claim);
    }
  }
  return claims.length > 0 ? claims.join("<br>") : "—";
}

function buildVersionTable(facts) {
  return [
    tableRow([
      "Domain",
      ...facts.harnesses.map(({ displayName }) =>
        shortHarnessName(displayName)
      ),
    ]),
    tableDivider(facts.harnesses.length, "---"),
    ...facts.enabledDomains.map((domain) =>
      tableRow([
        formatLabel(domain),
        ...facts.harnesses.map((harness) =>
          formatDomainEvidence(harness, domain)
        ),
      ])
    ),
  ].join("\n");
}

function buildSupportedVersionTable(facts) {
  const row = (label, pick) =>
    tableRow([label, ...facts.harnesses.map((harness) => pick(harness))]);
  return [
    tableRow([
      "",
      ...facts.harnesses.map(({ displayName }) =>
        shortHarnessName(displayName)
      ),
    ]),
    tableDivider(facts.harnesses.length, "---"),
    row("Minimum", ({ versionPolicy }) => versionPolicy.minimum),
    row("Recommended", ({ versionPolicy }) => versionPolicy.recommended),
    row("Update", ({ versionPolicy }) => `\`${versionPolicy.updateCommand}\``),
  ].join("\n");
}

export function buildCompatibilityDocumentation(facts, compatibilityTypes) {
  const presentation = fidelityPresentation(compatibilityTypes.fidelities);
  const { notes, noteByCell } = buildNotes(
    facts,
    compatibilityTypes,
    presentation
  );
  const legend = Object.values(presentation)
    .map(({ symbol, status }) => `${symbol} ${status.toLowerCase()}`)
    .join(" · ");

  return `${FRONTMATTER}

${GENERATED_HEADER}

# Harness compatibility

ctrlyoke keeps one workflow model across six CLI harnesses, but some workflow
features are translated differently or are not enforced by every harness. This
page is generated from the adapter-owned compatibility registry, the same
declarations that drive the dashboard's compatibility warnings.

## Compatibility matrix

${legend} · a superscript number links to the note that explains the limit.

${buildMatrix(facts, presentation, noteByCell)}

### Notes

${buildNotesSection(facts, notes)}

## How to read the matrix

- **Supported** means the adapter's behavior matches the workflow contract for
  the capability.
- **Partially supported** means the adapter translates or delivers only part
  of the workflow value.
- **Not supported** means the adapter does not enforce or attach that
  capability.
- The notes share their wording with author-time and preflight diagnostics.
  Simplify the value, or choose a harness that supports it, when a cell is
  not ✅.

## Supported versions

ctrlyoke is tested against the latest release of each harness CLI and supports
releases from roughly the past six months. A CLI older than **Minimum** is
treated as unavailable: the dashboard and \`ctrlyoke run\` show its update
command instead of running it. A CLI older than **Recommended** still runs, but
the harness picker marks it with a warning because newer features (for example
context-window or usage indicators) may be missing. These floors move forward
with each ctrlyoke release, so keeping harness CLIs up to date is the expected
setup.

${buildSupportedVersionTable(facts)}

## Verified versions

Each claim is backed by evidence for a harness version range. Installed
versions outside these ranges are shown as unverified by the dashboard.

${buildVersionTable(facts)}

::: details How each harness implements these capabilities

- **native**: the harness supports the workflow value directly.
- **translated-cli**: ctrlyoke translates the value into the harness's CLI
  flags or inline configuration for each run.
- **workspace-config**: ctrlyoke writes the harness's workspace configuration
  (for example its hooks file) for the run.
- **mixed**: a combination of the mechanisms above.
- **none**: there is no mechanism; the capability is not supported.

${buildMechanismTable(facts)}

:::

## Portable workflow attachments and native discovery

Workflow [\`agent\` and \`skills\` attachments](/workflows/agents-and-skills) are
portable across all six harnesses. ctrlyoke resolves their selected files,
wraps agent content in \`<agentInstructions>\`, and supplies both categories as
prompt references. They are deliberately outside this conditional capability
matrix.

The optional **Agents & Skills** settings page is a separate convenience for
copying files into harness-native discovery directories. Native discovery can
enable ambient skills or native subagent spawning, and its layout and behavior
vary by harness. It does not determine whether a workflow's \`agent\` or
\`skills\` attachment works, and it is not the workflow property's execution
mechanism. See [Agents and skills](/workflows/agents-and-skills) for both
paths.

Uniform workflow features are intentionally absent from the matrix: execution
mode, sessions, MCP server injection, usage, workflow agents, and workflow
skills are shared ctrlyoke behavior rather than conditional harness claims.

_This page is generated. Run \`npm run check:compatibility-docs\` to verify that
the checked-in page still matches the registry declarations._
`;
}

function main() {
  const facts = loadDocumentationFacts();
  const generated = buildCompatibilityDocumentation(
    facts,
    loadCompatibilityTypes()
  );

  if (CHECK_MODE) {
    const existing = readFileSync(OUTPUT_PATH, "utf8");
    if (existing !== generated) {
      console.error(
        `Compatibility documentation is out of date: ${OUTPUT_PATH}`
      );
      console.error(
        "Run npm run generate-compatibility-docs to regenerate it."
      );
      process.exitCode = 1;
      return;
    }
    console.log("Compatibility documentation is up to date.");
    return;
  }

  writeFileSync(OUTPUT_PATH, generated, "utf8");
  console.log(`Written: ${OUTPUT_PATH}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
