/**
 * Every async `fs`/`dns`/`zlib`/`crypto` call in Node is serviced by libuv's
 * threadpool, whose default size is **4 regardless of how many Promises are
 * fired concurrently**. `RunSummaryCache` validation and other batched
 * workspace scans issue far more concurrent `fs.stat`/`fs.readFile` calls than
 * that on a large history, so most of them queue rather than run in parallel —
 * on a slow filesystem (network share, antivirus-intercepted, or a
 * cloud-synced state root under OneDrive/Dropbox) that queuing dominates wall
 * time. Call this once, before any other module in the process performs async
 * file I/O, to raise the ceiling. `UV_THREADPOOL_SIZE` is read lazily on first
 * threadpool use, so "before first use" is enough — it does not need to run
 * before Node itself starts, but it must run before any imported module's own
 * top-level code touches the filesystem asynchronously.
 */
export function ensureMinFsThreadpoolSize(minSize: number): void {
  const current = Number(process.env.UV_THREADPOOL_SIZE);
  if (!Number.isFinite(current) || current < minSize) {
    process.env.UV_THREADPOOL_SIZE = String(minSize);
  }
}
