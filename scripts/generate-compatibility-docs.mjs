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

const GENERATED_HEADER =
  "<!-- AUTO-GENERATED — run `npm run generate-compatibility-docs` to update -->";

/** @typedef {{ fidelity: string, mechanism: string, verification?: { kind: string, reference: string, basis: string, verifiedVersions: string[] }, caveatCode?: string }} CapabilityDeclaration */

function installVscodeStub() {
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
    return `[evidence](${reference})`;
  }
  return `[source](https://github.com/FuzzyNova/ctrlyoke/blob/main/${reference})`;
}

function formatEvidence(declaration) {
  const verification = declaration.verification;
  if (!verification) {
    return "No version-scoped evidence recorded";
  }
  const versions = verification.verifiedVersions.join(", ");
  return `${verification.kind}; ${verification.basis}; ${versions}; ${formatReference(verification.reference)}`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function buildRows(facts, compatibilityTypes) {
  return facts.harnesses.flatMap(({ harnessId, displayName, capabilities }) =>
    facts.enabledDomains.flatMap((domain) =>
      collectLeaves(capabilities[domain]).map(({ capability, declaration }) => {
        const caveat = compatibilityTypes.getCompatibilityCaveatMessage(
          declaration.caveatCode
        );
        const remediation =
          compatibilityTypes.getCompatibilityDeclarationRemediation(
            domain,
            capability,
            declaration
          );
        return [
          displayName,
          harnessId,
          formatLabel(domain),
          formatLabel(capability),
          declaration.fidelity,
          declaration.mechanism,
          formatEvidence(declaration),
          caveat ?? "—",
          remediation ?? "—",
        ].map(escapeCell);
      })
    )
  );
}

export function buildCompatibilityDocumentation(facts, compatibilityTypes) {
  const rows = buildRows(facts, compatibilityTypes);
  const table = [
    "| Harness | ID | Domain | Capability | Fidelity | Mechanism | Evidence / verification scope | Caveat | Remediation |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

  return `${GENERATED_HEADER}

# Harness compatibility

ctrlyoke keeps one workflow model across six CLI harnesses, but some workflow
features are translated differently or are not enforced by every harness. This
page is generated from the adapter-owned compatibility registry. It records
the declared fidelity, mechanism, evidence, version scope, and the shared
caveat/remediation prose used by compatibility diagnostics.

## How to read the matrix

- **Exact** means the adapter's declared behavior matches the workflow
  contract for the capability.
- **Partial** means the adapter translates only part of the workflow value.
- **Unsupported** means the adapter does not enforce or attach that capability.
- **Evidence / verification scope** identifies the evidence kind, its basis,
  the covered harness versions, and the source used for the claim. Installed
  versions outside the listed ranges are shown as unverified by the dashboard.
- Caveats explain known architectural limits. Remediations are shared with
  author-time and preflight diagnostics; simplify the value or choose a
  harness with the required fidelity when a row is not exact.

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

Uniform workflow features are intentionally absent from the table: execution
mode, sessions, MCP server injection, usage, workflow agents, and workflow
skills are shared ctrlyoke behavior rather than conditional harness claims.

## Compatibility matrix

${table}

_This page is generated. Run \`npm run check:compatibility-docs\` to verify that
the checked-in page still matches the registry declarations._
`;
}

function main() {
  const facts = loadDocumentationFacts();
  const compatibilityTypes = require(
    resolve(ROOT_DIR, "out/types/CompatibilityTypes.js")
  );
  const generated = buildCompatibilityDocumentation(facts, compatibilityTypes);

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
