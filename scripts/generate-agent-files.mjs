#!/usr/bin/env node

/**
 * generate-agent-files.mjs — Auto-generate CLAUDE.md and AGENTS.md
 *
 * Scans .github/instructions/ for *.instructions.md files, reads their
 * `applyTo` frontmatter, and emits both CLAUDE.md and AGENTS.md with an
 * up-to-date instruction-file mapping table.
 *
 * Usage:
 *   node scripts/generate-agent-files.mjs          # Regenerate both files
 *   node scripts/generate-agent-files.mjs --check  # Exit 1 if files are out of sync (CI)
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const INSTRUCTIONS_DIR = resolve(ROOT_DIR, ".github/instructions");

const CHECK_MODE = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Parse instruction files
// ---------------------------------------------------------------------------

function parseFrontmatter(filePath) {
  const raw = readFileSync(filePath, "utf-8").replace(/^﻿/, ""); // strip BOM
  // Strip optional ```instructions fence used by some files
  const content = raw.startsWith("````instructions")
    ? raw.replace(/^````instructions\s*/, "")
    : raw;
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const block = match[1];
  const result = {};
  for (const line of block.split("\n")) {
    const kv = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (kv) result[kv[1]] = kv[2].trim();
  }
  return result;
}

function buildRows() {
  const files = readdirSync(INSTRUCTIONS_DIR)
    .filter((f) => f.endsWith(".instructions.md"))
    .sort();

  return files.flatMap((file) => {
    const { applyTo, exclude } = parseFrontmatter(
      resolve(INSTRUCTIONS_DIR, file)
    );
    if (!applyTo) return [];
    const pattern = exclude
      ? `\`${applyTo}\` (excl. \`${exclude}\`)`
      : `\`${applyTo}\``;
    return [{ pattern, file }];
  });
}

function buildTable(rows) {
  const col1 = Math.max(
    ...rows.map((r) => r.pattern.length),
    "File Pattern".length
  );
  const col2 = Math.max(
    ...rows.map((r) => r.file.length),
    "Instruction File".length
  );
  const pad = (s, n) => s.padEnd(n);
  const divider = `| ${"-".repeat(col1)} | ${"-".repeat(col2)} |`;
  const header = `| ${pad("File Pattern", col1)} | ${pad("Instruction File", col2)} |`;
  const dataRows = rows.map(
    ({ pattern, file }) => `| ${pad(pattern, col1)} | ${pad(file, col2)} |`
  );
  return [header, divider, ...dataRows].join("\n");
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

const HEADER =
  "<!-- AUTO-GENERATED — run `npm run generate-agent-files` to update -->";

function generateContent(table) {
  return `${HEADER}

# ctrlyoke Project Memory

## Core Project Context

Always read the main project instructions:

@.github/copilot-instructions.md

## Instruction Files

The \`.github/instructions/\` directory contains detailed implementation guidelines organized by file scope. Each instruction file covers a specific area of the codebase — check the table below to find which one applies to the files you're modifying.

**Read each instruction file once per session** (or per area you're working in). Once you've read an instruction file, you don't need to re-read it every time you edit another file in that same area.

${table}

### How to Use

1. Identify which pattern matches the files you're working on
2. Read the corresponding instruction file (only if you haven't already for this area)
3. Apply the patterns and conventions described in that file

### Example

\`\`\`
Working on src/core/WorkflowOrchestrator.ts?
→ Read: .github/instructions/core.instructions.md (once for the session)

Working on src/core/harness/CliIntegration.ts?
→ Read: .github/instructions/harness-integrations.instructions.md (once for the session)
\`\`\`

## Project Status

Pre-release — No backward compatibility constraints. Prioritize clean architecture and bold improvements.

## Key Principles

- **SOLID principles**: Separation of concerns, always look for opportunities to single source code and follow the DRY principle.
- **DRY (SINGLE SOURCE)**: Never duplicate code that can be single sourced in a helper function or base class.
- **TypeScript strict mode**: Comprehensive type safety
- **Single source of truth**: No hardcoded string duplication across files
- **Security first**: Workspace-scoped operations, process isolation for scripts
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const rows = buildRows();
const table = buildTable(rows);

const content = generateContent(table);
const outputs = [
  { path: resolve(ROOT_DIR, "CLAUDE.md"), content },
  { path: resolve(ROOT_DIR, "AGENTS.md"), content },
];

if (CHECK_MODE) {
  let dirty = false;
  for (const { path, content } of outputs) {
    const existing = readFileSync(path, "utf-8");
    if (existing !== content) {
      console.error(`Out of sync: ${path}`);
      dirty = true;
    }
  }
  if (dirty) {
    console.error("Run `npm run generate-agent-files` to regenerate.");
    process.exit(1);
  }
  console.log("Agent files are up to date.");
} else {
  for (const { path, content } of outputs) {
    writeFileSync(path, content, "utf-8");
    console.log(`Written: ${path}`);
  }
}
