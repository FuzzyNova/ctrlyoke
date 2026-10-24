#!/usr/bin/env node

/**
 * Snapshot skills.sh's all-time leaderboard for the Agent & Skills Manager.
 *
 * The skills.sh tab shows the top skills before the user searches. skills.sh
 * only serves its leaderboard (`GET /api/v1/skills`) to callers holding a
 * Vercel OIDC token, which expires after ~12 hours and is minted for one
 * Vercel project, so nothing long-lived can ship inside ctrlyoke. Instead a
 * maintainer runs this script before a release and commits the result; the
 * extension reads it via a normal `import` and labels it with its date. See
 * dev/implemented/SKILLS_REGISTRY_PLAN.md.
 *
 * Token: `VERCEL_OIDC_TOKEN` from the environment, else from `.env.local`
 * (written by `vercel link` + `vercel env pull`; gitignored by `.env.*`).
 *
 * The output keeps the `/api/search` response shape, so the extension
 * validates it with the same parser as a live search.
 *
 * Usage:
 *   npm run sync-skills-snapshot
 *   npm run chores -- --task sync-skills-snapshot
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

const LEADERBOARD_URL = "https://skills.sh/api/v1/skills";
const OUTPUT_PATH = resolve(
  ROOT_DIR,
  "src/utils/generated/skillsShTopSkills.json"
);
const ENV_FILE = resolve(ROOT_DIR, ".env.local");
const TOKEN_ENV = "VERCEL_OIDC_TOKEN";
const VIEW = "all-time";
/** Skills kept in the snapshot. */
const SNAPSHOT_SIZE = 100;
/** Fetched to leave room for the duplicates and non-GitHub skills dropped. */
const FETCH_SIZE = 200;
const GITHUB_SOURCE_TYPE = "github";

function readToken() {
  if (process.env[TOKEN_ENV]) return process.env[TOKEN_ENV];
  if (!existsSync(ENV_FILE)) return undefined;
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*VERCEL_OIDC_TOKEN\s*=\s*(.*)\s*$/);
    if (match) return match[1].replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

async function main() {
  const token = readToken();
  if (!token) {
    throw new Error(
      `${TOKEN_ENV} is not set. Run \`vercel link\` and \`vercel env pull\` in the repository root first (the token lasts ~12 hours).`
    );
  }

  const url = `${LEADERBOARD_URL}?view=${VIEW}&page=0&per_page=${FETCH_SIZE}`;
  console.log(`Fetching ${url} ...`);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `skills.sh leaderboard request failed: HTTP ${response.status} ${body.slice(0, 300)}`
    );
  }
  const body = await response.json();
  if (!Array.isArray(body?.data)) {
    throw new Error("skills.sh leaderboard returned an unexpected response");
  }

  // Forks/copies of other skills and /.well-known/ sources can't be
  // installed from a GitHub repository, so they are left out.
  const candidates = body.data
    .filter(
      (skill) =>
        skill &&
        skill.sourceType === GITHUB_SOURCE_TYPE &&
        skill.isDuplicate !== true &&
        typeof skill.source === "string" &&
        typeof skill.slug === "string" &&
        typeof skill.installs === "number"
    )
    .sort((a, b) => b.installs - a.installs);

  // skills.sh doesn't flag every copy: the same skill republished under
  // several owners can fill the leaderboard. A slug is also the folder a
  // skill installs into, so only the most-installed skill per slug is kept.
  const seenSlugs = new Set();
  const skills = candidates
    .filter((skill) => {
      const slug = skill.slug.toLowerCase();
      if (seenSlugs.has(slug)) return false;
      seenSlugs.add(slug);
      return true;
    })
    .slice(0, SNAPSHOT_SIZE)
    .map((skill) => ({
      id: `${skill.source}/${skill.slug}`,
      source: skill.source,
      skillId: skill.slug,
      name: typeof skill.name === "string" ? skill.name : skill.slug,
      installs: skill.installs,
    }));
  if (skills.length === 0) {
    throw new Error("skills.sh leaderboard returned no installable skills");
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    view: VIEW,
    skills,
  };
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  const dropped = candidates.length - seenSlugs.size;
  if (dropped > 0) {
    console.log(
      `Dropped ${dropped} skills sharing a name with a more-installed one`
    );
  }
  console.log(
    `Wrote ${skills.length} skills to ${OUTPUT_PATH.slice(ROOT_DIR.length + 1)}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
