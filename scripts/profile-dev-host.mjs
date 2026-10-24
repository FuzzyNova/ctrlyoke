#!/usr/bin/env node
/**
 * Profile the Extension Development Host over the Chrome DevTools Protocol and
 * print where its time (and, for the dashboard, its memory) went.
 *
 * Targets (--target, default exthost):
 *   exthost    The extension host's CPU. Attaches to a dev host started with
 *              CTRLYOKE_DEV_HOST_INSPECT_PORT=<port> (default 9229).
 *   dashboard  The dashboard webview's CPU plus a sampling allocation profile
 *              that counts garbage-collected objects too, so it shows what
 *              allocates, not only what survives. Attaches to a dev host
 *              started with CTRLYOKE_DEV_HOST_RENDERER_PORT=<port> (default
 *              9222).
 *
 * Usage:
 *   node scripts/profile-dev-host.mjs [--target <t>] --launch [isolated|shared|onboarding]
 *       Restarts the dev host with the target's port open first. For exthost
 *       the host is held before activation, so startup is captured in full.
 *   node scripts/profile-dev-host.mjs [--target <t>]
 *       Attaches to a dev host that is already running.
 *   node scripts/profile-dev-host.mjs --summarize <file.cpuprofile|file.heapprofile>
 *       Re-prints the summary of an earlier capture.
 *
 * Options: --port <n>, --seconds <n> (default 60; Enter or Ctrl+C stops
 * sooner), --interval-us <n> (CPU sampling interval, default 1000),
 * --min-stall-ms <n> (busy stretches to report, default 200), --top <n>.
 *
 * Both the extension host and the dashboard are bundled, so frames in out/
 * are mapped back to their TypeScript source through the sibling .js.map.
 * Captures are written to .ctrlyoke/logs/profiles/; a .cpuprofile opens as a
 * flame chart in VS Code or Chrome DevTools (Performance > Load profile), and
 * a .heapprofile in Chrome DevTools (Memory > Load).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SourceMap } from "node:module";
import path, { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const OUT_DIR = path.join(REPO_ROOT, "out");
const PROFILE_DIR = path.join(REPO_ROOT, ".ctrlyoke", "logs", "profiles");
const IDLE_FRAMES = new Set(["(idle)"]);
const META_FRAMES = new Set([
  "(root)",
  "(program)",
  "(garbage collector)",
  "(idle)",
]);

const packageJson = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
);
const EXTENSION_ID = `${packageJson.publisher}.${packageJson.name}`;

/**
 * What each --target attaches to. The dashboard is ctrlyoke's webview iframe
 * in the window's renderer; `purpose=webviewView` picks the dashboard view
 * over any editor-tab webview ctrlyoke has open.
 */
export const PROFILE_TARGETS = {
  exthost: {
    label: "extension host",
    defaultPort: 9229,
    portEnv: "CTRLYOKE_DEV_HOST_INSPECT_PORT",
    launchEnv: { CTRLYOKE_DEV_HOST_INSPECT_BRK: "1" },
    holdsAtLaunch: true,
    sampleHeap: false,
    pick: (targets) => targets.find((t) => t.webSocketDebuggerUrl),
  },
  dashboard: {
    label: "dashboard webview",
    defaultPort: 9222,
    portEnv: "CTRLYOKE_DEV_HOST_RENDERER_PORT",
    launchEnv: {},
    holdsAtLaunch: false,
    sampleHeap: true,
    pick: (targets) => {
      const ours = targets.filter(
        (t) =>
          t.type === "iframe" &&
          t.webSocketDebuggerUrl &&
          decodeURIComponent(t.url).includes(`extensionId=${EXTENSION_ID}`)
      );
      return (
        ours.find((t) =>
          decodeURIComponent(t.url).includes("purpose=webviewView")
        ) ?? ours[0]
      );
    },
  },
};

/** Frame categories, in the order the summary prints them. */
export const FRAME_CATEGORIES = {
  ctrlyoke: "ctrlyoke",
  dependency: "bundled dependency",
  node: "node internals",
  other: "other (VS Code / other extensions)",
  gc: "(garbage collector)",
  program: "(program)",
  idle: "(idle)",
};

function parseArgs(argv) {
  const options = {
    target: "exthost",
    port: undefined,
    seconds: 60,
    intervalUs: 1000,
    minStallMs: 200,
    top: 25,
    launch: undefined,
    summarize: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--target":
        options.target = next();
        if (!Object.hasOwn(PROFILE_TARGETS, options.target)) {
          throw new Error(
            `unknown target ${options.target}; choose ${Object.keys(PROFILE_TARGETS).join(" or ")}`
          );
        }
        break;
      case "--port":
        options.port = Number(next());
        break;
      case "--seconds":
        options.seconds = Number(next());
        break;
      case "--interval-us":
        options.intervalUs = Number(next());
        break;
      case "--min-stall-ms":
        options.minStallMs = Number(next());
        break;
      case "--top":
        options.top = Number(next());
        break;
      case "--launch":
        options.launch =
          argv[i + 1] && !argv[i + 1].startsWith("--") ? next() : "shared";
        break;
      case "--summarize":
        options.summarize = next();
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  options.port ??= PROFILE_TARGETS[options.target].defaultPort;
  return options;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP ──────────────────────────────────────────────────────────────────────

async function findInspectorTarget(target, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const found = target.pick(await response.json());
      if (found) return found.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(
    `no ${target.label} to attach to on port ${port} — start the dev host with ${target.portEnv}=${port}, or pass --launch`
  );
}

function connect(url) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const handler = message.id != null && pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    });
    socket.addEventListener("error", () =>
      reject(new Error(`cannot connect to ${url}`))
    );
    socket.addEventListener("open", () =>
      resolveSocket({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) =>
            pending.set(id, { resolve: res, reject: rej })
          );
        },
        close: () => socket.close(),
      })
    );
  });
}

function waitForStop(seconds) {
  return new Promise((resolveStop) => {
    const finish = (reason) => {
      clearTimeout(timer);
      process.off("SIGINT", onSigint);
      process.stdin.pause();
      resolveStop(reason);
    };
    const onSigint = () => finish("interrupted");
    const timer = setTimeout(
      () => finish(`${seconds}s elapsed`),
      seconds * 1000
    );
    process.once("SIGINT", onSigint);
    if (process.stdin.isTTY) {
      process.stdin.resume();
      process.stdin.once("data", () => finish("Enter pressed"));
    }
  });
}

function launchDevHost(mode, target, port) {
  console.log(
    `restarting the dev host (${mode}) with the ${target.label} on port ${port}...`
  );
  const child = spawn(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "dev-host.mjs"), "restart", mode],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        [target.portEnv]: String(port),
        ...target.launchEnv,
      },
      stdio: ["ignore", "inherit", "inherit"],
    }
  );
  return new Promise((resolveExit) => child.on("exit", resolveExit));
}

/**
 * Counts objects later collected by GC as well, so the profile measures
 * allocation churn rather than only what is still alive at the end. Older
 * Chromium rejects the flags; then only surviving objects are counted.
 */
async function startHeapSampling(cdp) {
  await cdp.send("HeapProfiler.enable");
  try {
    await cdp.send("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    return true;
  } catch {
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32_768 });
    return false;
  }
}

async function capture(options) {
  const target = PROFILE_TARGETS[options.target];
  const devHostExit = options.launch
    ? launchDevHost(options.launch, target, options.port)
    : undefined;
  // --launch compiles first, so give it far longer than an attach.
  const url = await findInspectorTarget(
    target,
    options.port,
    options.launch ? 300_000 : 5_000
  );
  const cdp = await connect(url);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", {
    interval: options.intervalUs,
  });
  await cdp.send("Profiler.start");
  const countsCollected = target.sampleHeap
    ? await startHeapSampling(cdp)
    : undefined;
  if (options.launch && target.holdsAtLaunch) {
    await cdp.send("Runtime.runIfWaitingForDebugger");
    await cdp.send("Debugger.enable");
    await cdp.send("Debugger.resume").catch(() => {});
    await cdp.send("Debugger.disable");
  }
  console.log(
    `profiling the ${target.label} — reproduce the slowdown now; stopping after ${options.seconds}s${process.stdin.isTTY ? " or on Enter" : ""}.`
  );
  const reason = await waitForStop(options.seconds);
  const { profile } = await cdp.send("Profiler.stop");
  const heapProfile = target.sampleHeap
    ? (await cdp.send("HeapProfiler.stopSampling")).profile
    : undefined;
  cdp.close();
  await devHostExit;

  mkdirSync(PROFILE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(PROFILE_DIR, `${options.target}-${stamp}`);
  writeFileSync(`${base}.cpuprofile`, JSON.stringify(profile));
  if (heapProfile) {
    writeFileSync(`${base}.heapprofile`, JSON.stringify(heapProfile));
  }
  console.log(
    `\nstopped (${reason}); written to ${base}.cpuprofile${heapProfile ? ` and .heapprofile${countsCollected ? "" : " (surviving objects only: this Chromium cannot count collected ones)"}` : ""}\n`
  );
  return { profile, heapProfile };
}

// ── Frame resolution ────────────────────────────────────────────────────────

/**
 * The local out/ file a script URL was served from, or undefined. The
 * extension host loads `file:///c:/…/out/extension.js`; the webview loads the
 * same path through a resource URL such as
 * `https://file+.vscode-resource.vscode-cdn.net/c%3A/…/out/ui/…/dashboard.js`.
 */
export function localOutFileForUrl(url, outDir = OUT_DIR) {
  const outMarker = `${outDir.replace(/\\/g, "/").toLowerCase()}/`;
  let decoded;
  try {
    decoded = decodeURIComponent(url.split(/[?#]/)[0]).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
  const at = decoded.toLowerCase().indexOf(outMarker);
  return at < 0
    ? undefined
    : path.join(outDir, decoded.slice(at + outMarker.length));
}

/**
 * Resolves a CDP call frame to a readable `source:line` location, mapping
 * bundled out/*.js frames through their source maps.
 */
export function createFrameResolver(outDir = OUT_DIR) {
  const maps = new Map();

  function sourceMapFor(url) {
    if (!maps.has(url)) {
      let map = null;
      try {
        const file = localOutFileForUrl(url, outDir);
        if (file && existsSync(`${file}.map`))
          map = new SourceMap(JSON.parse(readFileSync(`${file}.map`, "utf8")));
      } catch {
        map = null;
      }
      maps.set(url, map);
    }
    return maps.get(url);
  }

  return function resolveFrame(callFrame) {
    const name = callFrame.functionName || "(anonymous)";
    if (META_FRAMES.has(name)) {
      return {
        key: name,
        label: name,
        category:
          name === "(garbage collector)"
            ? FRAME_CATEGORIES.gc
            : name === "(idle)"
              ? FRAME_CATEGORIES.idle
              : FRAME_CATEGORIES.program,
      };
    }
    const url = callFrame.url ?? "";
    if (url.startsWith("node:") || (!url && callFrame.scriptId === "0")) {
      return {
        key: `${name} ${url}`,
        label: `${name} (${url || "native"})`,
        category: FRAME_CATEGORIES.node,
      };
    }
    if (localOutFileForUrl(url, outDir)) {
      const entry = sourceMapFor(url)?.findEntry(
        callFrame.lineNumber,
        callFrame.columnNumber
      );
      if (entry?.originalSource) {
        const source = entry.originalSource
          .replace(/^.*?(?=(src|node_modules)[\\/])/, "")
          .replace(/\\/g, "/");
        const category = source.includes("node_modules/")
          ? FRAME_CATEGORIES.dependency
          : FRAME_CATEGORIES.ctrlyoke;
        const shortSource = source.replace(/^.*node_modules\//, "");
        const label = `${name}  ${shortSource}:${entry.originalLine + 1}`;
        return { key: label, label, category };
      }
    }
    const location = url
      ? `${url.replace(/^file:\/\/\//, "")}:${callFrame.lineNumber + 1}`
      : "native";
    const label = `${name}  ${location}`;
    return { key: label, label, category: FRAME_CATEGORIES.other };
  };
}

// ── Summary ─────────────────────────────────────────────────────────────────

/**
 * Turns a V8 CPU profile into per-function self/total times and the busy
 * stretches that blocked the event loop, each with its heaviest ctrlyoke
 * frames. Pure so it can be tested on a synthetic profile.
 */
export function summarizeProfile(
  profile,
  resolveFrame,
  { minStallMs = 200, top = 25 } = {}
) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const frames = new Map(
    profile.nodes.map((node) => [node.id, resolveFrame(node.callFrame)])
  );
  // Deepest call depth per frame, so equal-time frames list the innermost
  // (closest to the actual work) first.
  const depthByKey = new Map();
  const visitDepth = (id, depth) => {
    const key = frames.get(id).key;
    depthByKey.set(key, Math.max(depthByKey.get(key) ?? 0, depth));
    for (const child of nodes.get(id).children ?? [])
      visitDepth(child, depth + 1);
  };
  visitDepth(profile.nodes[0].id, 0);

  // Each sample's duration is the delta to the next sample.
  const sampleMs = profile.timeDeltas.map(
    (_, i) => (profile.timeDeltas[i + 1] ?? 0) / 1000
  );
  const startTime = profile.startTime;
  const sampleStart = [];
  let cursor = startTime;
  for (const delta of profile.timeDeltas) {
    cursor += delta;
    sampleStart.push((cursor - startTime) / 1000);
  }

  const stackKeys = (nodeId) => {
    const keys = new Set();
    for (let id = nodeId; id != null; id = parent.get(id))
      keys.add(frames.get(id).key);
    return keys;
  };

  const self = new Map();
  const total = new Map();
  const categories = new Map();
  const labelByKey = new Map([...frames.values()].map((f) => [f.key, f.label]));
  const add = (map, key, ms) => map.set(key, (map.get(key) ?? 0) + ms);

  const stalls = [];
  let stall = null;
  const closeStall = () => {
    if (stall && stall.durationMs >= minStallMs) stalls.push(stall);
    stall = null;
  };

  profile.samples.forEach((nodeId, i) => {
    const ms = sampleMs[i];
    const frame = frames.get(nodeId);
    add(self, frame.key, ms);
    add(categories, frame.category, ms);
    const keys = stackKeys(nodeId);
    for (const key of keys) add(total, key, ms);

    if (IDLE_FRAMES.has(frame.key)) {
      closeStall();
      return;
    }
    stall ??= { startMs: sampleStart[i], durationMs: 0, total: new Map() };
    stall.durationMs += ms;
    for (const key of keys) add(stall.total, key, ms);
  });
  closeStall();

  const ranked = (map, filter = () => true) =>
    [...map.entries()]
      .filter(([key]) => filter(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([key, ms]) => ({ label: labelByKey.get(key) ?? key, ms }));

  const categoryByKey = new Map(
    [...frames.values()].map((f) => [f.key, f.category])
  );
  const isCtrlyoke = (key) =>
    categoryByKey.get(key) === FRAME_CATEGORIES.ctrlyoke;
  const isWork = (key) => !META_FRAMES.has(key);

  return {
    durationMs: (profile.endTime - profile.startTime) / 1000,
    categories: Object.values(FRAME_CATEGORIES).map((name) => ({
      name,
      ms: categories.get(name) ?? 0,
    })),
    topSelf: ranked(self, isWork),
    topCtrlyokeTotal: ranked(total, isCtrlyoke),
    stalls: stalls
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, top)
      .map((s) => ({
        startMs: s.startMs,
        durationMs: s.durationMs,
        heaviest: [...s.total.entries()]
          .filter(([key]) => isCtrlyoke(key))
          .sort(
            (a, b) =>
              b[1] - a[1] ||
              (depthByKey.get(b[0]) ?? 0) - (depthByKey.get(a[0]) ?? 0)
          )
          .slice(0, 6)
          .map(([key, ms]) => ({ label: labelByKey.get(key) ?? key, ms })),
      })),
  };
}

/**
 * Turns a sampling heap profile into bytes allocated per function (self) and
 * per ctrlyoke function including its callees (total). Sizes are V8's
 * sample-scaled estimates. Pure so it can be tested on a synthetic profile.
 */
export function summarizeHeapProfile(profile, resolveFrame, { top = 25 } = {}) {
  const self = new Map();
  const total = new Map();
  const categories = new Map();
  const labelByKey = new Map();
  const categoryByKey = new Map();
  const add = (map, key, bytes) => map.set(key, (map.get(key) ?? 0) + bytes);
  let totalBytes = 0;

  const visit = (node, stack) => {
    const frame = resolveFrame(node.callFrame);
    labelByKey.set(frame.key, frame.label);
    categoryByKey.set(frame.key, frame.category);
    const keys = new Set(stack).add(frame.key);
    if (node.selfSize > 0) {
      totalBytes += node.selfSize;
      add(self, frame.key, node.selfSize);
      add(categories, frame.category, node.selfSize);
      for (const key of keys) add(total, key, node.selfSize);
    }
    for (const child of node.children ?? []) visit(child, keys);
  };
  visit(profile.head, new Set());

  const ranked = (map, filter) =>
    [...map.entries()]
      .filter(([key]) => filter(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([key, bytes]) => ({ label: labelByKey.get(key) ?? key, bytes }));

  return {
    totalBytes,
    categories: Object.values(FRAME_CATEGORIES)
      .map((name) => ({ name, bytes: categories.get(name) ?? 0 }))
      .filter(({ bytes }) => bytes > 0),
    topSelf: ranked(self, (key) => !META_FRAMES.has(key)),
    topCtrlyokeTotal: ranked(
      total,
      (key) => categoryByKey.get(key) === FRAME_CATEGORIES.ctrlyoke
    ),
  };
}

function printHeapSummary(summary) {
  const fmt = (bytes) => `${(bytes / 1024 / 1024).toFixed(1).padStart(7)}MB`;
  console.log(
    `\nAllocated ${fmt(summary.totalBytes).trim()} in total.\n\nAllocation by category:`
  );
  for (const { name, bytes } of summary.categories)
    console.log(`  ${fmt(bytes)}  ${name}`);
  console.log("\nLargest allocators by self bytes:");
  for (const f of summary.topSelf) console.log(`  ${fmt(f.bytes)}  ${f.label}`);
  console.log("\nLargest ctrlyoke allocators including callees:");
  for (const f of summary.topCtrlyokeTotal)
    console.log(`  ${fmt(f.bytes)}  ${f.label}`);
}

function printSummary(summary) {
  const fmt = (ms) => `${ms.toFixed(0).padStart(7)}ms`;
  const pct = (ms) =>
    `${((ms / summary.durationMs) * 100).toFixed(1).padStart(5)}%`;
  console.log(
    `Captured ${(summary.durationMs / 1000).toFixed(1)}s.\n\nTime by category:`
  );
  for (const { name, ms } of summary.categories)
    console.log(`  ${fmt(ms)} ${pct(ms)}  ${name}`);

  console.log("\nBusy stretches that blocked the main thread (longest first):");
  if (summary.stalls.length === 0) console.log("  none");
  for (const s of summary.stalls) {
    console.log(`  ${fmt(s.durationMs)} at +${(s.startMs / 1000).toFixed(2)}s`);
    for (const h of s.heaviest) console.log(`      ${fmt(h.ms)}  ${h.label}`);
  }

  console.log("\nHottest functions by self time (excluding idle/GC/program):");
  for (const f of summary.topSelf) console.log(`  ${fmt(f.ms)}  ${f.label}`);

  console.log("\nHottest ctrlyoke functions by total time (self + callees):");
  for (const f of summary.topCtrlyokeTotal)
    console.log(`  ${fmt(f.ms)}  ${f.label}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const resolveFrame = createFrameResolver();
    let profile;
    let heapProfile;
    if (!options.summarize) {
      ({ profile, heapProfile } = await capture(options));
    } else if (options.summarize.endsWith(".heapprofile")) {
      heapProfile = JSON.parse(readFileSync(options.summarize, "utf8"));
    } else {
      profile = JSON.parse(readFileSync(options.summarize, "utf8"));
    }
    if (profile) {
      printSummary(
        summarizeProfile(profile, resolveFrame, {
          minStallMs: options.minStallMs,
          top: options.top,
        })
      );
    }
    if (heapProfile) {
      printHeapSummary(
        summarizeHeapProfile(heapProfile, resolveFrame, { top: options.top })
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
