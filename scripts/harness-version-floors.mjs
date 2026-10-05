#!/usr/bin/env node

/**
 * Suggest each harness's `versionPolicy` for the next ctrlyoke release.
 *
 * Read-only: prints the current policy beside a suggested minimum (the first
 * release inside the support window, from the npm registry's publish times)
 * and the CLI version installed on this machine (the candidate "recommended",
 * once the release has been verified against it). Edit the providers'
 * `versionPolicy` by hand, then delete code that only served versions below
 * the new minimums. See dev/reference/HARNESS_VERSION_SUPPORT.md.
 *
 * Usage:
 *   npm run harness:version-floors
 *   npm run harness:version-floors -- --months 6
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installVscodeStub } from "./generate-compatibility-docs.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const DEFAULT_WINDOW_MONTHS = 6;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

function parseWindowMonths(argv) {
  const index = argv.indexOf("--months");
  if (index === -1) return DEFAULT_WINDOW_MONTHS;
  const months = Number(argv[index + 1]);
  if (!Number.isFinite(months) || months <= 0) {
    throw new Error("--months expects a positive number");
  }
  return months;
}

/** The npm package named by a provider's `npm install -g <pkg>` install hint. */
function npmPackageFromInstallHint(installHint) {
  return installHint.match(/npm install -g (\S+)/)?.[1];
}

async function firstReleaseSince(packageName, cutoff) {
  const response = await fetch(
    `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`
  );
  if (!response.ok) {
    return { error: `npm registry ${response.status}` };
  }
  const { time } = await response.json();
  const releases = Object.entries(time ?? {})
    .filter(([version]) => STABLE_VERSION.test(version))
    .map(([version, published]) => ({
      version,
      published: new Date(published),
    }))
    .sort((left, right) => left.published - right.published);
  const first = releases.find(({ published }) => published >= cutoff);
  return first
    ? { version: first.version, published: first.published }
    : { error: "no release in window" };
}

async function main() {
  const months = parseWindowMonths(process.argv);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  const restore = installVscodeStub();
  let IntegrationFactory;
  let HARNESS_IDS;
  let assessHarnessVersion;
  try {
    ({ IntegrationFactory } = require(
      resolve(ROOT_DIR, "out/core/IntegrationFactory.js")
    ));
    ({ HARNESS_IDS } = require(
      resolve(ROOT_DIR, "out/types/DashboardConstants.js")
    ));
    ({ assessHarnessVersion } = require(
      resolve(ROOT_DIR, "out/utils/HarnessVersion.js")
    ));
  } finally {
    restore();
  }

  console.log(
    `Support window: releases published since ${cutoff.toISOString().slice(0, 10)} (${months} months)\n`
  );
  for (const harnessId of Object.values(HARNESS_IDS)) {
    const provider = IntegrationFactory.createCapabilityProvider(harnessId);
    const { displayName, installHint, versionPolicy } = provider.config;
    const packageName = npmPackageFromInstallHint(installHint);
    const window = packageName
      ? await firstReleaseSince(packageName, cutoff)
      : { error: "no npm package in installHint; choose by hand" };
    const installed = assessHarnessVersion(
      await provider.getVersion().catch(() => undefined),
      versionPolicy
    ).installedVersion;

    console.log(displayName);
    console.log(
      `  minimum      ${versionPolicy.minimum.padEnd(10)} suggested: ${
        window.version
          ? `${window.version} (published ${window.published.toISOString().slice(0, 10)})`
          : window.error
      }`
    );
    console.log(
      `  recommended  ${versionPolicy.recommended.padEnd(10)} installed here: ${installed ?? "not installed"}`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
