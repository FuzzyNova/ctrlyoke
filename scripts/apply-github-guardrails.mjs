#!/usr/bin/env node
/**
 * Applies the repository's GitHub guardrails through the `gh` CLI, so the
 * settings live in version control instead of only in the Settings UI.
 *
 * Usage:
 *   node scripts/apply-github-guardrails.mjs [--dry-run]
 *
 * Idempotent: rulesets are matched by name and updated in place, and every
 * other call is a PUT/PATCH of the desired state. Run it again after editing
 * the definitions below.
 *
 * Rulesets, secret scanning, push protection, private vulnerability reporting
 * and the fork-PR approval policy need a public repository on GitHub's free
 * plan, and those calls fail with HTTP 403 while the repo is private. Each step
 * is applied independently and reported, so a run before the visibility flip
 * applies what it can. Run it again right after the flip
 * (dev/active/RELEASE_CHECKLIST.md Phase 14.5).
 */

import { execFileSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");

/** Built-in "Repository admin" role; admins may push to `main` and create tags directly. */
const ADMIN_BYPASS = [
  { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
];

/** The GitHub Actions app, so only a check reported by Actions satisfies the requirement. */
const GITHUB_ACTIONS_APP_ID = 15368;

/** Job id in .github/workflows/ci.yml. */
const REQUIRED_CHECK = "fast-checks";

const RULESETS = [
  {
    name: "main",
    target: "branch",
    enforcement: "active",
    bypass_actors: ADMIN_BYPASS,
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          require_code_owner_review: true,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: true,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [
            { context: REQUIRED_CHECK, integration_id: GITHUB_ACTIONS_APP_ID },
          ],
        },
      },
    ],
  },
  {
    // release.yml publishes on any pushed v* tag, so only admins may create, move or delete one.
    name: "release tags",
    target: "tag",
    enforcement: "active",
    bypass_actors: ADMIN_BYPASS,
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [
      { type: "creation" },
      { type: "update" },
      { type: "deletion" },
      { type: "non_fast_forward" },
    ],
  },
];

function gh(args, body) {
  return execFileSync(
    "gh",
    body === undefined ? args : [...args, "--input", "-"],
    {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}

function ghJson(args, body) {
  const out = gh(args, body);
  return out.trim() ? JSON.parse(out) : undefined;
}

const repo = ghJson(["repo", "view", "--json", "nameWithOwner,visibility"]);
const base = `repos/${repo.nameWithOwner}`;
console.log(
  `${repo.nameWithOwner} (${repo.visibility.toLowerCase()})${dryRun ? " -- dry run" : ""}\n`
);

const steps = [
  ...RULESETS.map((ruleset) => ({
    label: `ruleset "${ruleset.name}"`,
    apply() {
      const existing = ghJson(["api", `${base}/rulesets`]).find(
        (r) => r.name === ruleset.name
      );
      if (existing) {
        gh(["api", "-X", "PUT", `${base}/rulesets/${existing.id}`], ruleset);
      } else {
        gh(["api", "-X", "POST", `${base}/rulesets`], ruleset);
      }
    },
  })),
  {
    label: "Actions: default GITHUB_TOKEN is read-only and cannot approve PRs",
    apply: () =>
      gh(["api", "-X", "PUT", `${base}/actions/permissions/workflow`], {
        default_workflow_permissions: "read",
        can_approve_pull_request_reviews: false,
      }),
  },
  {
    label:
      "Actions: require approval to run workflows for all outside contributors",
    apply: () =>
      gh(
        [
          "api",
          "-X",
          "PUT",
          `${base}/actions/permissions/fork-pr-contributor-approval`,
        ],
        {
          approval_policy: "all_external_contributors",
        }
      ),
  },
  {
    label: "Dependabot alerts",
    apply: () => gh(["api", "-X", "PUT", `${base}/vulnerability-alerts`]),
  },
  {
    label: "Secret scanning + push protection",
    apply: () =>
      gh(["api", "-X", "PATCH", base], {
        security_and_analysis: {
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "enabled" },
        },
      }),
  },
  {
    label: "Private vulnerability reporting",
    apply: () =>
      gh(["api", "-X", "PUT", `${base}/private-vulnerability-reporting`]),
  },
];

let failures = 0;
for (const step of steps) {
  if (dryRun) {
    console.log(`would apply: ${step.label}`);
    continue;
  }
  try {
    step.apply();
    console.log(`ok      ${step.label}`);
  } catch (error) {
    failures++;
    const detail = String(error.stderr || error.message)
      .trim()
      .split("\n")
      .pop();
    console.log(`FAILED  ${step.label}\n        ${detail}`);
  }
}

if (failures > 0) {
  console.log(
    `\n${failures} step(s) failed.${repo.visibility === "PRIVATE" ? " Most need a public repo; run again after the flip." : ""}`
  );
  process.exitCode = 1;
}
