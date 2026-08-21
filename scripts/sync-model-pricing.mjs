#!/usr/bin/env node

/**
 * Sync ctrlyoke's entire model-pricing registry from models.dev.
 *
 * `src/utils/ModelPricing.ts` used to hand-maintain a per-harness price table
 * (`MODEL_PRICING`) typed out by hand from each vendor's own docs. That table
 * is gone — every harness now prices models by looking them up in the
 * snapshot this script downloads, via `src/utils/ModelPricingRegistry.ts`.
 * There is no per-model dollar amount to type anywhere in this codebase
 * anymore; refreshing prices means re-running this script, not editing code.
 *
 * Why models.dev: it's a single, MIT-licensed, community-maintained
 * model/pricing database (https://github.com/anomalyco/models.dev) that
 * already covers every vendor ctrlyoke's six harnesses touch — including a
 * `github-copilot` provider bucket that tracks GitHub's own Copilot billing
 * docs, and an `opencode` provider bucket that is the literal upstream
 * catalog OpenCode's own CLI uses for its model list and cost display
 * (confirmed 2026-08-21) — so OpenCode's own `<provider>/<model>` IDs match
 * its provider buckets natively.
 *
 * This is a build-time-only fetch, run manually via chores — ctrlyoke does
 * not call models.dev at runtime (offline-by-default is a project
 * requirement; see the "Cost is not spend" design notes in
 * dev/implemented/PROMPT_TOTAL_TOKEN_USAGE_PLAN.md). The output is a trimmed
 * (cost-fields-only) JSON snapshot committed to the repo, read by
 * `src/utils/ModelPricingRegistry.ts` at runtime via a normal `import`.
 *
 * Usage:
 *   node scripts/sync-model-pricing.mjs
 *   npm run sync-model-pricing
 *   npm run chores -- --task sync-model-pricing
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "..");

const MODELS_DEV_URL = "https://models.dev/api.json";
const OUTPUT_PATH = resolve(
  ROOT_DIR,
  "src/utils/generated/modelPricingRegistryData.json"
);

/**
 * Trim one models.dev model entry down to just the USD-per-million-token
 * rates ctrlyoke's `ModelPricing` shape needs. Returns undefined for entries
 * with no usable input/output rate (e.g. non-chat modes) so they're dropped
 * entirely rather than stored as an all-undefined stub.
 */
function trimCost(cost) {
  if (!cost || typeof cost !== "object") return undefined;
  const trimmed = {};
  if (typeof cost.input === "number") trimmed.input = cost.input;
  if (typeof cost.output === "number") trimmed.output = cost.output;
  if (typeof cost.cache_read === "number") trimmed.cacheRead = cost.cache_read;
  if (typeof cost.cache_write === "number")
    trimmed.cacheWrite = cost.cache_write;
  return trimmed.input !== undefined || trimmed.output !== undefined
    ? trimmed
    : undefined;
}

async function main() {
  console.log(`Fetching ${MODELS_DEV_URL} ...`);
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) {
    throw new Error(
      `models.dev fetch failed: ${response.status} ${response.statusText}`
    );
  }
  /** @type {Record<string, { models?: Record<string, { cost?: unknown }> }>} */
  const registry = await response.json();

  const providers = {};
  let providerCount = 0;
  let modelCount = 0;

  for (const [providerId, provider] of Object.entries(registry)) {
    if (!provider || typeof provider.models !== "object") continue;
    const bucket = {};
    for (const [modelId, model] of Object.entries(provider.models)) {
      const cost = trimCost(model && model.cost);
      if (cost) {
        bucket[modelId] = cost;
        modelCount++;
      }
    }
    if (Object.keys(bucket).length > 0) {
      providers[providerId] = bucket;
      providerCount++;
    }
  }

  const output = {
    sourceUrl: MODELS_DEV_URL,
    generatedAt: new Date().toISOString().slice(0, 10),
    providers,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");

  console.log(
    `✓ Wrote ${providerCount} providers / ${modelCount} priced models to`
  );
  console.log(`  ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(`✗ Failed to sync model pricing: ${error.message}`);
  process.exitCode = 1;
});
