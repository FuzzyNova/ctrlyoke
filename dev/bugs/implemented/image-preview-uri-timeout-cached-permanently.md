# Image-preview URI timeout is cached permanently as null, so one slow reply turns that image into a file-ref fallback for the rest of the session

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (ui)
- **Area:** `src/ui/webview-react/components/output/MarkdownText.tsx`
- **Resolution:** fixed in this commit

## Symptom

An image thumbnail in output markdown sometimes shows as a plain file-ref chip instead of the image. It stays that way for the rest of the webview session, in every run that references the same path, after scrolling or re-mounts, and after the host has become responsive again. Only reloading the webview brings the image back.

## Steps to Reproduce

1. Block the dashboard's `routeQueue` for more than 15 s. A cold `#` completion (about 10 s), a large `loadRunView` (46.7 s seen in the session logs) or `ready` (19.4 s) will do it. On the hosted dashboard, a reconnect gap does the same, because the shim drops outbound messages while the socket is down.
2. Meanwhile, render output that contains a workspace image (`![](images/foo.png)`).
3. After 15 s the thumbnail falls back to a file-ref. Scroll away and back, or open another run that references the same image: it stays a file-ref and no new `REQUEST_FILE_PREVIEW_URI` is sent.

## Root Cause

- `MarkdownText.tsx:597`: `PREVIEW_URI_TIMEOUT_MS = 15_000`.
- `:599`: `imagePreviewUriCache` is a module-level `Map<string, string | null>` that nothing ever evicts or clears (it is only read at `:620`, `:711`, `:719` and written at `:641`).
- `:634`: `setTimeout(() => finish(null), PREVIEW_URI_TIMEOUT_MS)` settles the request with `null` when the host is slow.
- `:640-643`: `.then((uri) => imagePreviewUriCache.set(relativePath, uri))` stores the timeout's `null` exactly as if it were a definitive "can't preview" answer from the host. From then on, `:620-621` short-circuits every request for that path.
- `finish` deletes the seq's resolver, so the host's late real answer is ignored. The timer is also never cleared when the host replies first (it later fires on an already-settled promise, which is harmless but a leak).
- `REQUEST_FILE_PREVIEW_URI` (`src/ui/WebviewMessageRouter.ts:1461`) goes through the shared serialized `routeQueue`, so any slow handler can delay its reply past 15 s.

## Suggested Fix

- Cache only definitive host answers. On timeout, resolve the current render with `null`, but delete the in-flight entry and leave `imagePreviewUriCache` untouched, so the next mount asks again. Optionally keep the seq resolver registered so a late answer still fills the cache and updates any mounted thumbnail.
- Clear the timeout when the host answers.
- Consider a short TTL, or invalidating cached `null`s on file-change events, too. A host `null` for an image that does not exist _yet_ (one a step writes later) is cached forever today.
- The underlying delay is the shared `routeQueue`. `REQUEST_FILE_PREVIEW_URI` is a read-only lookup and could go in `OFF_QUEUE_MESSAGE_TYPES`.
