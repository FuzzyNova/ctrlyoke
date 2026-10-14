import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file isolation under `isolate: false` (see vitest.config.ts)
//
// A worker reuses one jsdom window and one module graph for every file it
// runs, and the setup file re-runs at the start of each of them. That makes it
// the place to restore what a fresh environment used to give for free. Each
// section below exists because a real cross-file leak failed tests without it.
// ---------------------------------------------------------------------------

// The host-injected globals the dashboard reads. Several files set these at
// file level (often inside `vi.hoisted`) and never unset them, which silently
// ran every later file in the same worker in hosted-browser mode. Files set
// them after setup runs, so clearing here does not undo a file's own setup.
const INJECTED_WINDOW_GLOBALS = [
  "__ctrlyokeStandalone",
  "__ctrlyokeReactMounted",
  "__ctrlyokePanelHandshakeDone",
  "__ctrlyokeRetryPanelHandshake",
  "__ctrlyokeBootstrapLog",
  "__ctrlyokeFlushBootstrapLogs",
  "ctrlyokeProfiler",
] as const satisfies ReadonlyArray<keyof Window>;

// Layout geometry jsdom does not compute is routinely stubbed on these
// prototypes (`offsetHeight`, `getBoundingClientRect`, `scrollTo`, a Range
// `getClientRects` polyfill). A file that forgets to restore one hands every
// later file fake geometry, which silently changes what a virtualized list
// renders. Restoring from a pristine snapshot covers all of them at once.
const GUARDED_PROTOTYPES: object[] = [
  Node.prototype,
  Element.prototype,
  HTMLElement.prototype,
  HTMLCanvasElement.prototype,
  Range.prototype,
  Document.prototype,
];

// Anything a file leaves attached to the shared window outlives it and keeps
// running against the next file: a module's `popstate` listener reacting to a
// later file's navigation, a profiler rAF loop recursing through a later
// file's synchronous rAF stub. `vi.resetModules()` cannot reach these because
// the old module instances are still referenced by the window, so record what
// each file registers and tear it down once the file is done.
//
// Only registrations made by this repo's own source are recorded. Externalized
// libraries stay cached for the whole worker and some register once per
// document or process behind a marker — React DOM's document listeners, its
// scheduler's pending timeout — so tearing theirs down breaks every later file
// (inputs stopped firing onChange when this guard recorded everything).
interface FileLeakRecord {
  listeners: Array<{
    target: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | EventListenerOptions;
  }>;
  timers: Array<ReturnType<typeof setTimeout>>;
  frames: number[];
}

/** Own property descriptors keyed by string *and* symbol (unlike `PropertyDescriptorMap`). */
type DescriptorSnapshot = { [key: string | symbol]: PropertyDescriptor };

interface FileLeakGuard {
  current: FileLeakRecord;
  initialHref: string;
  prototypeSnapshots: Array<[object, DescriptorSnapshot]>;
}

// The guard outlives `vi.resetModules()` — this module is re-evaluated for
// every file — so it lives on the worker's global, installed exactly once.
const LEAK_GUARD_KEY = Symbol.for("ctrlyoke.test.fileLeakGuard");
type GuardedGlobal = typeof globalThis & { [LEAK_GUARD_KEY]?: FileLeakGuard };

const THIS_FILE_FRAME = "test/fileIsolation.ts";
const NODE_MODULES_FRAME = "node_modules";
const PROJECT_SOURCE_FRAME = /[\\/]src[\\/]/;

/** True when the nearest caller outside this file is repo source, not a dependency. */
function calledFromProjectSource(): boolean {
  const caller = (new Error().stack ?? "")
    .split("\n")
    .slice(1)
    .find((frame) => !frame.includes(THIS_FILE_FRAME));
  return (
    caller !== undefined &&
    PROJECT_SOURCE_FRAME.test(caller) &&
    !caller.includes(NODE_MODULES_FRAME)
  );
}

function emptyLeakRecord(): FileLeakRecord {
  return { listeners: [], timers: [], frames: [] };
}

function installFileLeakGuard(): FileLeakGuard {
  const guarded = globalThis as GuardedGlobal;
  const existing = guarded[LEAK_GUARD_KEY];
  if (existing) {
    return existing;
  }
  const guard: FileLeakGuard = {
    current: emptyLeakRecord(),
    initialHref: window.location.href,
    prototypeSnapshots: GUARDED_PROTOTYPES.map((proto) => [
      proto,
      Object.getOwnPropertyDescriptors(proto) as DescriptorSnapshot,
    ]),
  };
  guarded[LEAK_GUARD_KEY] = guard;

  for (const target of [window, document] as EventTarget[]) {
    const addEventListener = target.addEventListener.bind(target);
    target.addEventListener = (type, listener, options) => {
      if (listener && calledFromProjectSource()) {
        guard.current.listeners.push({ target, type, listener, options });
      }
      addEventListener(type, listener, options);
    };
  }

  const setTimeoutImpl = globalThis.setTimeout;
  const setIntervalImpl = globalThis.setInterval;
  const requestAnimationFrameImpl = globalThis.requestAnimationFrame;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const id = setTimeoutImpl(...args);
    if (calledFromProjectSource()) {
      guard.current.timers.push(id);
    }
    return id;
  }) as typeof setTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const id = setIntervalImpl(...args);
    if (calledFromProjectSource()) {
      guard.current.timers.push(id);
    }
    return id;
  }) as typeof setInterval;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = requestAnimationFrameImpl(callback);
    if (calledFromProjectSource()) {
      guard.current.frames.push(id);
    }
    return id;
  };

  return guard;
}

function restorePrototype(proto: object, pristine: DescriptorSnapshot): void {
  const current = Object.getOwnPropertyDescriptors(proto) as DescriptorSnapshot;
  for (const key of Reflect.ownKeys(current)) {
    if (!Object.prototype.hasOwnProperty.call(pristine, key)) {
      Reflect.deleteProperty(proto, key);
    }
  }
  for (const key of Reflect.ownKeys(pristine)) {
    const original = pristine[key];
    const now: PropertyDescriptor | undefined = current[key];
    if (
      !now ||
      now.value !== original.value ||
      now.get !== original.get ||
      now.set !== original.set
    ) {
      Object.defineProperty(proto, key, original);
    }
  }
}

function tearDownFile(guard: FileLeakGuard): void {
  const { listeners, timers, frames } = guard.current;
  for (const { target, type, listener, options } of listeners) {
    target.removeEventListener(type, listener, options);
  }
  // clearTimeout and clearInterval share one id space.
  timers.forEach((id) => clearTimeout(id));
  frames.forEach((id) => cancelAnimationFrame(id));
  guard.current = emptyLeakRecord();

  for (const [proto, pristine] of guard.prototypeSnapshots) {
    restorePrototype(proto, pristine);
  }

  // Vitest restores mocks between files but not these: one file's
  // `vi.stubGlobal("requestAnimationFrame", <synchronous stub>)` otherwise made
  // rAF synchronous for every later file and broke virtualized scrolling. The
  // setup file's own stubs are re-applied when it runs for the next file.
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();

  // Nodes rendered outside a Testing Library container (mermaid's measuring
  // div, hand-built portal roots) survive `cleanup()`.
  document.body.replaceChildren();
  window.history.replaceState(null, "", guard.initialHref);
}

/**
 * Gives the test file about to run a clean slate in the worker's shared
 * environment, and registers the teardown for what it leaves behind. Call it
 * first in the setup file, before anything installs mocks on `window`.
 */
export function isolateTestFile(): void {
  // Re-evaluate the dashboard's own modules. Without this, a module an earlier
  // file already imported keeps the dependencies it was imported with, so a
  // later file's `vi.mock` of one of them silently has no effect, and every
  // store/module-level singleton carries the earlier file's state.
  // Externalized node_modules (React, CodeMirror, ...) stay cached, which
  // together with the reused jsdom is where the saving comes from.
  vi.resetModules();

  // Web storage lives on the shared window, and several modules read it at
  // import time (e.g. the performance profiler's enabled flag).
  window.localStorage.clear();
  window.sessionStorage.clear();

  for (const key of INJECTED_WINDOW_GLOBALS) {
    delete window[key];
  }

  const guard = installFileLeakGuard();
  guard.current = emptyLeakRecord();

  // Testing Library registers its own `afterEach(cleanup)` when the module is
  // first imported. It is externalized and so stays cached across files, which
  // means that hook only reaches the first file a worker runs and every later
  // one inherits the previous file's rendered DOM.
  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    tearDownFile(guard);
  });
}
