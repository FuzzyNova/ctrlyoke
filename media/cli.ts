/**
 * Media capture entry point: `npm run media -- <command>` from the repo root.
 * See media/README.md and dev/backlog/MEDIA_CAPTURE_AUTOMATION_PLAN.md.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { prepareDemoApp, setupDemoApp } from "./lib/demoApp.ts";
import { startHost, stopHost } from "./lib/devHost.ts";
import { quantizePng } from "./lib/encode.ts";
import { run } from "./lib/exec.ts";
import { MEDIA_DIR, SCREENSHOTS_DIR } from "./lib/paths.ts";
import { findRunFixture, listRunFixtures } from "./lib/runs.ts";
import {
  outputFiles,
  selectStills,
  type CaptureOptions,
  type Shot,
} from "./lib/shot.ts";
import { SHOTS } from "./shots/index.ts";

const USAGE = `usage: npm run media -- <command> [options]

commands:
  setup          install media dependencies and Chromium, clone demo-app
  list           list the shots, their files and the recorded runs
  <shot>...      capture these shots
  --all          capture every shot
  host [<shot>]  start the capture host with that shot's fixtures, print its
                 URL and leave it running (stop it: npm run dev:host:stop)
  replay <run>   like host, but on that recorded run's start state, armed to
                 replay the run when its workflow is run

options:
  --only <file>     capture only this still
  --out <dir>       write PNGs here instead of images/screenshots/ (to preview)
  --speed <n>       replay speed (default 1; 0 jumps to each step's end state)
  --pause-at <seq>  pause the replay before this event sequence number`;

function setup(): void {
  run("npm", ["install"], MEDIA_DIR);
  run("npx", ["playwright", "install", "chromium"], MEDIA_DIR);
  setupDemoApp();
}

function findShot(id: string): Shot {
  const shot = SHOTS.find((candidate) => candidate.id === id);
  if (!shot) {
    throw new Error(`unknown shot '${id}'. Run \`npm run media -- list\`.`);
  }
  return shot;
}

async function capture(shots: Shot[], options: CaptureOptions): Promise<void> {
  if (!existsSync(path.join(MEDIA_DIR, "node_modules", "playwright"))) {
    throw new Error(
      "media dependencies are missing. Run `npm run media -- setup`."
    );
  }
  // Loaded lazily so `setup` works before playwright is installed.
  const { captureStage, compose } = await import("./lib/stills.ts");
  for (const shot of shots) {
    const files = selectStills(shot, options.only);
    for (const stage of shot.stages) {
      if (!stage.stills.some((still) => files.has(still.file))) continue;
      prepareDemoApp(stage.workflows ?? []);
      const url = await startHost(stage.host);
      try {
        await captureStage(stage, url, files, options);
      } finally {
        stopHost();
      }
    }
    const written = shot.stages
      .flatMap((stage) => stage.stills)
      .filter((still) => !still.part && files.has(still.file))
      .map((still) => still.file);
    for (const composite of shot.composites ?? []) {
      if (composite.parts.every((part) => files.has(part))) {
        await compose(composite, options);
        written.push(composite.file);
      }
    }
    if (shot.quantize) {
      for (const file of written) quantizePng(path.join(options.outDir, file));
    }
  }
}

function list(): void {
  for (const shot of SHOTS) {
    console.log(`${shot.id.padEnd(20)} ${shot.description}`);
    for (const file of outputFiles(shot))
      console.log(`${"".padEnd(21)}${file}`);
  }
  console.log("\nrecorded runs (replay <run>):");
  for (const fixture of listRunFixtures()) {
    console.log(`${fixture.name.padEnd(22)} ${fixture.description}`);
  }
}

function parseCount(
  name: string,
  value: string | undefined
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      only: { type: "string" },
      out: { type: "string" },
      speed: { type: "string" },
      "pause-at": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const options: CaptureOptions = {
    only: values.only,
    outDir: values.out ? path.resolve(values.out) : SCREENSHOTS_DIR,
  };
  const [command, ...rest] = positionals;

  if (values.help) return console.log(USAGE);
  if (values.all) return capture(SHOTS, options);
  switch (command) {
    case undefined:
    case "help":
      console.log(USAGE);
      return;
    case "setup":
      return setup();
    case "list":
      return list();
    case "host": {
      // The first stage's host and fixtures, for exploring a shot by hand.
      const stage = rest[0] ? findShot(rest[0]).stages[0] : undefined;
      prepareDemoApp(stage?.workflows ?? []);
      console.log(await startHost(stage?.host));
      return;
    }
    case "replay": {
      if (!rest[0]) throw new Error("usage: npm run media -- replay <run>");
      const fixture = findRunFixture(rest[0]);
      prepareDemoApp([], fixture.startTag);
      const replay = {
        bundleDir: fixture.bundleDir,
        speed: parseCount("speed", values.speed),
        pauseAt: parseCount("pause-at", values["pause-at"]),
      };
      console.log(await startHost({ replay }));
      return;
    }
    default:
      return capture(positionals.map(findShot), options);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
