/**
 * Mocha root-hook plugin for `npm run test:harness`: records which CLI version
 * of each harness the run exercised and how its cases fared.
 *
 * Loaded with `--require`, so it wraps every harness test file. At suite start
 * it asks the ctrlyoke CLI itself (`validate --all-installed-harnesses`) which
 * harnesses it finds and at which versions — the same detection path and
 * `PATH` lookup a real run uses, so `test:harness:minimum`'s substituted CLIs
 * are reported as what they are. At suite end it writes
 * `.ctrlyoke/logs/test-runs/harness-<time>.json` (harness → version →
 * pass/fail), which is what a `versionPolicy.testedWith` update copies from.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import type { Context } from "mocha";
import type { CliValidationJsonResult } from "../../../cli/CliJsonResultBuilder";
import { HarnessCapabilityRegistry } from "../../../core/HarnessCapabilityRegistry";
import { HARNESS_IDS, type HarnessId } from "../../../types/DashboardConstants";
import {
  assessHarnessVersion,
  type HarnessVersionAssessment,
} from "../../../utils/HarnessVersion";

const CLI_PATH = path.resolve(__dirname, "../../../cli.js");
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REPORT_DIR = path.join(REPO_ROOT, ".ctrlyoke", "logs", "test-runs");

/** Set by `scripts/test-harness-minimum.mjs` for a run against the minimums. */
const HARNESS_VERSION_MODE_ENV = "CTRLYOKE_HARNESS_VERSION_MODE";

type CaseOutcome = "passed" | "failed" | "pending";

interface HarnessReportEntry {
  harnessId: HarnessId;
  available: boolean;
  rawVersion: string | null;
  assessment: HarnessVersionAssessment | null;
  cases: Record<CaseOutcome, number>;
  failures: string[];
}

interface HarnessVersionReport {
  schemaVersion: 1;
  mode: string;
  startedAt: string;
  completedAt?: string;
  harnesses: HarnessReportEntry[];
  /** Cases whose title names no harness. */
  shared: Record<CaseOutcome, number>;
}

const emptyOutcomes = (): Record<CaseOutcome, number> => ({
  passed: 0,
  failed: 0,
  pending: 0,
});

/** Detect every harness through the ctrlyoke CLI, as a run would. */
function detectHarnesses(): HarnessReportEntry[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cy-harness-versions-"));
  try {
    const workflow = path.join(dir, "probe.ctrlyoke.json");
    fs.writeFileSync(
      workflow,
      JSON.stringify({ steps: [{ prompt: "version probe" }] })
    );
    const result = spawnSync(
      "node",
      [CLI_PATH, "validate", workflow, "--json", "--all-installed-harnesses"],
      { cwd: dir, encoding: "utf8", timeout: 120_000 }
    );
    const json = JSON.parse(
      result.stdout.trim().split(/\r?\n/).pop() ?? "{}"
    ) as Partial<CliValidationJsonResult>;
    const detected = json.target?.harnesses ?? [];
    const policies = new Map(
      HarnessCapabilityRegistry.getDocumentationFacts().harnesses.map((h) => [
        h.harnessId,
        h.versionPolicy,
      ])
    );
    return Object.values(HARNESS_IDS).map((harnessId) => {
      const found = detected.find((h) => h.harnessId === harnessId);
      const policy = policies.get(harnessId);
      return {
        harnessId,
        available: found?.available ?? false,
        rawVersion: found?.version ?? null,
        assessment:
          found?.version && policy
            ? assessHarnessVersion(found.version, policy)
            : null,
        cases: emptyOutcomes(),
        failures: [],
      };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let report: HarnessVersionReport | undefined;

function harnessOf(fullTitle: string): HarnessReportEntry | undefined {
  return report?.harnesses.find((entry) => fullTitle.includes(entry.harnessId));
}

function printDetected(entries: readonly HarnessReportEntry[]): void {
  console.log("\nHarness CLI versions under test:");
  for (const entry of entries) {
    const a = entry.assessment;
    const installed = entry.available
      ? (a?.installedVersion ?? entry.rawVersion ?? "unknown")
      : "not installed";
    const policy = a
      ? ` (minimum ${a.minimumVersion}, testedWith ${a.testedWithVersion}, ${a.status})`
      : "";
    console.log(`  ${entry.harnessId.padEnd(16)} ${installed}${policy}`);
  }
  console.log("");
}

function writeReport(finished: HarnessVersionReport): string {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(
    REPORT_DIR,
    `harness-${finished.startedAt.replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(file, JSON.stringify(finished, null, 2) + "\n");
  return file;
}

export const mochaHooks = {
  beforeAll(this: Context): void {
    this.timeout(180_000);
    const harnesses = detectHarnesses();
    report = {
      schemaVersion: 1,
      mode: process.env[HARNESS_VERSION_MODE_ENV] ?? "installed",
      startedAt: new Date().toISOString(),
      harnesses,
      shared: emptyOutcomes(),
    };
    printDetected(harnesses);
  },

  afterEach(this: Context): void {
    const test = this.currentTest;
    if (!report || !test) return;
    const outcome: CaseOutcome =
      test.state === "failed" ? "failed" : test.pending ? "pending" : "passed";
    const title = test.fullTitle();
    const entry = harnessOf(title);
    (entry?.cases ?? report.shared)[outcome]++;
    if (outcome === "failed") entry?.failures.push(title);
  },

  afterAll(): void {
    if (!report) return;
    const file = writeReport({
      ...report,
      completedAt: new Date().toISOString(),
    });
    console.log("\nHarness version report:");
    for (const entry of report.harnesses) {
      const version = entry.assessment?.installedVersion ?? "-";
      const { passed, failed } = entry.cases;
      console.log(
        `  ${entry.harnessId.padEnd(16)} ${version.padEnd(10)} ${passed} passed, ${failed} failed`
      );
    }
    console.log(`  Written to ${file}\n`);
  },
};
