/**
 * PDF viewer (Section 8 Page 6) — renders pages to `<canvas>` via PDF.js (`react-pdf`).
 *
 * This is the stable, known-working version. It uses base64 byte transfer
 * (`read_file_base64`) and a fixed virtualization buffer. The earlier "v3" experiment
 * (thumbnails sidebar + outline + raw-bytes + progressive buffer) introduced a render
 * loop that froze the app on a PDF route — those features are re-added one at a time,
 * carefully, only after this baseline is confirmed working.
 *
 * Features:
 *  - Fit Width (default) / Fit Page / Actual size + zoom (− % +).
 *  - Continuous virtualized scroll (only current page ± BUFFER renders to canvas).
 *  - Editable page box (click → selects; type + Enter to jump).
 *  - Fullscreen (button or F; Esc exits natively).
 *  - Keyboard: ←/→ prev/next page, +/−/0 zoom/reset, R rotate, F fullscreen,
 *    Home/End first/last, arrows/space/PgUp/PgDn scroll natively.
 *  - Rotate, selectable text (PDF.js text layer).
 *  - Scroll position preserved as a fraction on zoom/resize.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ipc, isTauri } from "../../lib/ipc";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type FitMode = "width" | "page" | "actual";

const PAD = 8; // stage inner padding (small → bigger page)
const GAP = 10; // gap between pages
const BUFFER = 3; // pages rendered above/below the current one (virtualization)
const DEFAULT_ASPECT = 0.707; // A4 portrait w/h fallback before the first page loads

/** Decode a base64 string (from `read_file_base64`) into a Uint8Array. */
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default function PdfViewer({ path }: { path: string }) {
  // ── PDF data ───────────────────────────────────────────────────────────────
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [nativeW, setNativeW] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ── View state ─────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<FitMode>("width");
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ── Container size ─────────────────────────────────────────────────────────
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollFracRef = useRef(0);
  const pageInputFocusedRef = useRef(false);
  const rafRef = useRef(0);

  // ── Load file bytes via IPC (base64) ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setNumPages(0);
    setAspect(DEFAULT_ASPECT);
    setNativeW(0);
    setCurrentPage(1);
    setPageInput("1");
    setMode("width");
    setZoom(1);
    setRotate(0);
    setLoadError(null);
    setLoading(true);
    scrollFracRef.current = 0;

    if (!isTauri()) {
      setLoading(false);
      return;
    }

    ipc
      .readFileBase64(path)
      .then((b64) => {
        if (!cancelled) setBytes(base64ToUint8Array(b64));
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  const file = useMemo(() => (bytes ? { data: bytes } : undefined), [bytes]);

  const onDocumentLoadSuccess = useCallback(async (pdf: pdfjs.PDFDocumentProxy) => {
    setNumPages(pdf.numPages);
    try {
      const p1 = await pdf.getPage(1);
      const vp = p1.getViewport({ scale: 1 });
      const a = vp.width / vp.height;
      setAspect(Number.isFinite(a) && a > 0 ? a : DEFAULT_ASPECT);
      setNativeW(vp.width);
    } catch {
      /* keep defaults */
    }
    setLoading(false);
  }, []);

  const onDocumentLoadError = useCallback((err: Error) => {
    setLoadError(err.message);
    setLoading(false);
  }, []);

  // ── Measure the stage (ResizeObserver) ─────────────────────────────────────
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      setContainerW((prev) => (prev === w ? prev : w));
      setContainerH((prev) => (prev === h ? prev : h));
    };
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    update();
    return () => ro.disconnect();
  }, []);

  // ── Derived geometry ───────────────────────────────────────────────────────
  const availW = Math.max(0, containerW - 2 * PAD);
  const availH = Math.max(0, containerH - 2 * PAD);

  const baseWidth =
    mode === "width" ? availW : mode === "page" ? Math.min(availW, availH * aspect) : nativeW;
  const pageWidth = Math.max(50, baseWidth * zoom);
  const rotOdd = rotate === 90 || rotate === 270;
  const effAspect = aspect > 0 ? (rotOdd ? 1 / aspect : aspect) : 1;
  const pageHeight = pageWidth / effAspect;
  const slotH = pageHeight + GAP;

  const renderStart = Math.max(1, currentPage - BUFFER);
  const renderEnd = Math.min(numPages, currentPage + BUFFER);

  // ── Scroll → current page + fraction (rAF-throttled) ───────────────────────
  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const stage = stageRef.current;
      if (!stage) return;
      const total = stage.scrollHeight - stage.clientHeight;
      if (total > 0) scrollFracRef.current = stage.scrollTop / total;
      if (slotH > 0 && numPages > 0) {
        const idx = Math.floor((stage.scrollTop + stage.clientHeight * 0.3) / slotH);
        setCurrentPage((prev) => {
          const next = Math.max(1, Math.min(numPages, idx + 1));
          return next === prev ? prev : next;
        });
      }
    });
  }, [slotH, numPages]);

  useEffect(() => {
    if (!pageInputFocusedRef.current) setPageInput(String(currentPage));
  }, [currentPage]);

  // Preserve scroll fraction when geometry changes.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || numPages === 0) return;
    const total = stage.scrollHeight - stage.clientHeight;
    if (total > 0) stage.scrollTop = scrollFracRef.current * total;
  }, [pageWidth, numPages, slotH]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const setFitMode = (m: FitMode) => {
    setMode(m);
    setZoom(1);
  };
  const zoomIn = () => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(2)));
  const resetZoom = () => {
    setZoom(1);
    setMode("width");
  };
  const rotatePage = () => setRotate((r) => (r + 90) % 360);

  const jumpToPage = useCallback(
    (n: number) => {
      const stage = stageRef.current;
      if (!stage || numPages === 0) return;
      const target = Math.max(1, Math.min(numPages, n));
      stage.scrollTo({ top: (target - 1) * slotH, behavior: "smooth" });
    },
    [numPages, slotH],
  );
  const goPrev = useCallback(() => jumpToPage(currentPage - 1), [jumpToPage, currentPage]);
  const goNext = useCallback(() => jumpToPage(currentPage + 1), [jumpToPage, currentPage]);

  // Fullscreen is unified on the Tauri OS-window (same model as the video player), NOT the
  // HTML5 Fullscreen API. The HTML5 path fought AppShell's window-resize → isFullscreen()
  // listener: entering element-fullscreen resized the window, the shell read the OS window
  // as NOT fullscreen, re-rendered layout, and the browser immediately dropped fullscreen
  // (the "opens then instantly escapes" bug). Using the OS window means one fullscreen
  // concept app-wide; AppShell already hides its chrome for it.
  const toggleFullscreen = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const w = getCurrentWindow();
      const target = !(await w.isFullscreen());
      await w.setFullscreen(target);
      setIsFullscreen(target);
      window.dispatchEvent(new CustomEvent("app-fullscreen-changed", { detail: target }));
    } catch {
      /* ignore — user can still use OS controls */
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    const sync = async () => {
      try {
        const fs = await getCurrentWindow().isFullscreen();
        if (active) setIsFullscreen(fs);
      } catch {
        /* ignore */
      }
    };
    void sync();
    getCurrentWindow()
      .onResized(() => void sync())
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // ── Keyboard shortcuts (active in fullscreen too — window-level) ───────────
  useEffect(() => {
    if (numPages === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      switch (e.key) {
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "ArrowRight":
          e.preventDefault();
          goNext();
          break;
        case "ArrowLeft":
          e.preventDefault();
          goPrev();
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomIn();
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomOut();
          break;
        case "0":
          e.preventDefault();
          resetZoom();
          break;
        case "r":
        case "R":
          e.preventDefault();
          rotatePage();
          break;
        case "Home":
          e.preventDefault();
          jumpToPage(1);
          break;
        case "End":
          e.preventDefault();
          jumpToPage(numPages);
          break;
        case "Escape":
          // OS-window fullscreen isn't auto-exited by the browser (unlike the old HTML5
          // path), so handle Esc ourselves when we're fullscreen.
          if (isTauri()) {
            void getCurrentWindow().isFullscreen().then((fs) => {
              if (fs) void toggleFullscreen();
            });
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages, currentPage, slotH, goNext, goPrev, jumpToPage, toggleFullscreen]);

  const ready = numPages > 0;

  return (
    <div ref={rootRef} className="flex h-full flex-col rounded-card bg-ink-900" data-fullscreen={isFullscreen}>
      {/* Toolbar */}
      <div className="glass flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-none border-x-0 border-t-0 px-3 py-2 text-xs text-content-secondary">
        <div className="flex items-center gap-1">
          <button type="button" onClick={goPrev} disabled={!ready || currentPage <= 1} className="rounded-btn px-2 py-1 hover:bg-white/[0.06] disabled:opacity-30" aria-label="Previous page">←</button>
          <input
            type="text"
            inputMode="numeric"
            value={pageInput}
            disabled={!ready}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
            onFocus={(e) => {
              pageInputFocusedRef.current = true;
              e.target.select();
            }}
            onBlur={() => {
              pageInputFocusedRef.current = false;
              setPageInput(String(currentPage));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
                jumpToPage(Number(pageInput) || 1);
              }
            }}
            className="w-12 rounded-btn bg-white/[0.06] px-1 py-1 text-center tabular-nums text-content-primary focus:outline-none focus:ring-1 focus:ring-lime/40 disabled:opacity-30"
            aria-label="Page number"
          />
          <span className="tabular-nums text-content-muted">/ {numPages || "—"}</span>
          <button type="button" onClick={goNext} disabled={!ready || currentPage >= numPages} className="rounded-btn px-2 py-1 hover:bg-white/[0.06] disabled:opacity-30" aria-label="Next page">→</button>
        </div>

        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setFitMode("width")} disabled={!ready} className={"rounded-btn px-2 py-1 transition-colors disabled:opacity-30 " + (mode === "width" ? "bg-lime/15 text-lime" : "hover:bg-white/[0.06]")} title="Fit Width (0)">Fit W</button>
          <button type="button" onClick={() => setFitMode("page")} disabled={!ready} className={"rounded-btn px-2 py-1 transition-colors disabled:opacity-30 " + (mode === "page" ? "bg-lime/15 text-lime" : "hover:bg-white/[0.06]")} title="Fit Page">Fit P</button>
          <button type="button" onClick={() => setFitMode("actual")} disabled={!ready || nativeW === 0} className={"rounded-btn px-2 py-1 transition-colors disabled:opacity-30 " + (mode === "actual" ? "bg-lime/15 text-lime" : "hover:bg-white/[0.06]")} title="Actual size">100%</button>
          <span className="mx-1 h-4 w-px bg-white/10" />
          <button type="button" onClick={zoomOut} disabled={!ready} className="rounded-btn px-2 py-1 hover:bg-white/[0.06] disabled:opacity-30" aria-label="Zoom out">−</button>
          <span className="w-12 text-center tabular-nums">{Math.round((pageWidth / (baseWidth || 1)) * 100)}%</span>
          <button type="button" onClick={zoomIn} disabled={!ready} className="rounded-btn px-2 py-1 hover:bg-white/[0.06] disabled:opacity-30" aria-label="Zoom in">+</button>
          <span className="mx-1 h-4 w-px bg-white/10" />
          <button type="button" onClick={rotatePage} disabled={!ready} className="rounded-btn px-2 py-1 hover:bg-white/[0.06] disabled:opacity-30" title="Rotate (R)" aria-label="Rotate">⟳</button>
          <button
            type="button"
            onClick={toggleFullscreen}
            disabled={!ready}
            className={"rounded-btn px-2.5 py-1 transition-colors disabled:opacity-30 " + (isFullscreen ? "bg-lime/15 text-lime" : "hover:bg-white/[0.06]")}
            title="Fullscreen (F)"
            aria-label="Toggle fullscreen"
          >
            {isFullscreen ? "⤢ Exit" : "⛶ Full"}
          </button>
        </div>
      </div>

      {/* Page stage */}
      <div ref={stageRef} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-auto bg-ink-900">
        {loadError ? (
          <div className="grid h-full place-items-center p-card text-center text-sm text-orange">
            Couldn't load this PDF.
            <span className="mt-1 block text-xs text-content-faint">{loadError}</span>
          </div>
        ) : !bytes ? (
          <div className="grid h-full place-items-center text-sm text-content-muted">
            {loading ? "Loading PDF…" : "No document"}
          </div>
        ) : (
          <Document file={file} onLoadSuccess={onDocumentLoadSuccess} onLoadError={onDocumentLoadError} loading={null} error={null}>
            <div className="flex flex-col items-center" style={{ paddingTop: PAD, paddingBottom: PAD, gap: GAP }}>
              {Array.from({ length: numPages }, (_, i) => {
                const n = i + 1;
                const renderThis = n >= renderStart && n <= renderEnd;
                return (
                  <PageSlot
                    key={n}
                    pageNumber={n}
                    pageWidth={pageWidth}
                    pageHeight={pageHeight}
                    rotate={rotate}
                    render={renderThis}
                  />
                );
              })}
            </div>
          </Document>
        )}
      </div>
    </div>
  );
}

/** A single page slot — memoized so scrolling only re-renders the slots whose render
 *  status or geometry actually changed (keeps a long doc smooth). */
const PageSlot = memo(function PageSlot({
  pageNumber,
  pageWidth,
  pageHeight,
  rotate,
  render,
}: {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  rotate: number;
  render: boolean;
}) {
  return (
    <div
      style={{ height: pageHeight, width: pageWidth }}
      className="relative shrink-0 overflow-hidden rounded-card bg-ink-800 shadow-card"
    >
      {render ? (
        <Page pageNumber={pageNumber} width={pageWidth} rotate={rotate} renderTextLayer renderAnnotationLayer={false} className="mx-auto" />
      ) : (
        <div className="grid h-full w-full place-items-center text-xs text-content-faint">Page {pageNumber}</div>
      )}
    </div>
  );
});
