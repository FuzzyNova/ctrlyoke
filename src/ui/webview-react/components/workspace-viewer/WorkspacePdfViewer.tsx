import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import {
  loadWorkspacePdfSupport,
  PDFJS_ASSET_PATH,
} from "@utils/workspacePdfSupport/loadWorkspacePdfSupport";

export interface WorkspacePdfViewerProps {
  rawUrl: string;
  compact?: boolean;
  label?: string;
}

interface PdfPageInfo {
  page: PDFPageProxy;
}

function PdfPage({ page, scale }: PdfPageInfo & { scale: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { rootMargin: "100% 0px" }
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !nearViewport) {
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }

    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform:
        outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    renderTaskRef.current = task;
    void task.promise.catch(() => undefined);
    return () => {
      task.cancel();
      if (renderTaskRef.current === task) renderTaskRef.current = null;
    };
  }, [nearViewport, page, scale, viewport]);

  return (
    <div
      ref={hostRef}
      className="mx-auto my-2 bg-white shadow-md"
      style={{
        width: viewport.width,
        height: viewport.height,
        minHeight: viewport.height,
      }}
      aria-label={`PDF page`}
    >
      <canvas ref={canvasRef} className="block max-w-full" />
    </div>
  );
}

export const WorkspacePdfViewer: React.FC<WorkspacePdfViewerProps> = ({
  rawUrl,
  compact = false,
  label = "PDF document",
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<PdfPageInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let document: PDFDocumentProxy | null = null;
    setPages([]);
    setError(null);
    setPageNumber(1);
    setPageCount(0);

    void (async () => {
      try {
        const pdfjs = await loadWorkspacePdfSupport();
        if (disposed) return;
        const base = PDFJS_ASSET_PATH;
        loadingTask = pdfjs.getDocument({
          url: rawUrl,
          cMapUrl: `${base}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`,
          wasmUrl: `${base}wasm/`,
          iccUrl: `${base}iccs/`,
          disableAutoFetch: true,
          disableStream: true,
          enableXfa: false,
        });
        document = await loadingTask.promise;
        if (disposed) {
          await loadingTask?.destroy();
          return;
        }
        setPageCount(document.numPages);
        const width = containerRef.current?.clientWidth ?? 800;
        const pageInfos: PdfPageInfo[] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
          const page = await document.getPage(number);
          pageInfos.push({ page });
        }
        if (disposed) return;
        const initialScale = pageInfos[0]
          ? Math.max(
              0.1,
              (width - 32) / pageInfos[0].page.getViewport({ scale: 1 }).width
            )
          : 1;
        setFitScale(initialScale);
        setScale(null);
        setPages(pageInfos);
      } catch (loadError) {
        if (!disposed) {
          setError(
            loadError instanceof Error && loadError.name === "PasswordException"
              ? "This PDF is password protected."
              : "This PDF could not be opened."
          );
        }
      }
    })();

    return () => {
      disposed = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [rawUrl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pages.length) return;
    const updateFit = () => {
      const baseWidth = pages[0].page.getViewport({ scale: 1 }).width;
      const next = Math.max(0.1, (container.clientWidth - 32) / baseWidth);
      setFitScale(next);
    };
    const observer = new ResizeObserver(updateFit);
    observer.observe(container);
    updateFit();
    return () => observer.disconnect();
  }, [pages]);

  const currentScale = scale ?? fitScale;
  const openLink = (
    <a
      href={rawUrl}
      target="_blank"
      rel="noreferrer"
      className="text-link-fg underline"
    >
      Open in new tab
    </a>
  );

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      aria-label={label}
    >
      <div
        className={`flex shrink-0 items-center justify-between gap-2 border-b border-panel-border text-xs ${compact ? "px-1 py-0.5" : "px-2 py-1"}`}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded px-1 hover:bg-button-secondary-bg"
            aria-label="Zoom out"
            onClick={() =>
              setScale((value) => Math.max(0.25, (value ?? fitScale) - 0.2))
            }
          >
            −
          </button>
          <button
            type="button"
            className="rounded px-1 hover:bg-button-secondary-bg"
            aria-label="Zoom in"
            onClick={() =>
              setScale((value) => Math.min(4, (value ?? fitScale) + 0.2))
            }
          >
            +
          </button>
          <button
            type="button"
            className="text-link-fg underline"
            onClick={() => setScale(null)}
          >
            Fit width
          </button>
          <span aria-live="polite">
            {pageCount ? `${pageNumber} / ${pageCount}` : "Loading PDF…"}
          </span>
        </div>
        {openLink}
      </div>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto bg-panel-bg px-2"
        onScroll={(event) => {
          const scrollTop = event.currentTarget.scrollTop;
          const visible =
            event.currentTarget.querySelectorAll<HTMLElement>(
              "[data-pdf-page]"
            );
          let nearest = 1;
          let distance = Number.POSITIVE_INFINITY;
          visible.forEach((element, index) => {
            const nextDistance = Math.abs(element.offsetTop - scrollTop);
            if (nextDistance < distance) {
              distance = nextDistance;
              nearest = index + 1;
            }
          });
          setPageNumber(nearest);
        }}
      >
        {error ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 text-sm text-description-fg"
            role="alert"
          >
            <span>{error}</span>
            {openLink}
          </div>
        ) : (
          pages.map((info, index) => (
            <div key={`${rawUrl}:${index + 1}`} data-pdf-page>
              <PdfPage {...info} scale={currentScale} />
            </div>
          ))
        )}
      </div>
    </div>
  );
};
