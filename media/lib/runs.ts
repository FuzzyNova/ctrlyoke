import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "./paths.ts";

/**
 * Recorded runs the capture host can replay (MEDIA_CAPTURE_AUTOMATION_PLAN.md
 * §5). Each is a run bundle from `ctrlyoke export` plus the demo-app tag the
 * run started from: replay brings back the harness output, the tag brings back
 * the files it worked on.
 */
export interface RunFixture {
  name: string;
  bundleDir: string;
  startTag: string;
  description: string;
}

const RUNS_DIR = path.join(FIXTURES_DIR, "runs");

export function listRunFixtures(): RunFixture[] {
  const entries = JSON.parse(
    readFileSync(path.join(RUNS_DIR, "fixtures.json"), "utf8")
  ) as Record<
    string,
    { bundle: string; startTag: string; description: string }
  >;
  return Object.entries(entries).map(([name, entry]) => ({
    name,
    bundleDir: path.join(RUNS_DIR, entry.bundle),
    startTag: entry.startTag,
    description: entry.description,
  }));
}

export function findRunFixture(name: string): RunFixture {
  const fixture = listRunFixtures().find(
    (candidate) => candidate.name === name
  );
  if (!fixture) {
    throw new Error(
      `unknown run fixture '${name}'. Run \`npm run media -- list\`.`
    );
  }
  if (!existsSync(fixture.bundleDir)) {
    throw new Error(
      `run fixture '${name}' has no bundle at ${fixture.bundleDir}`
    );
  }
  return fixture;
}
