import React, { useState, useCallback, useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';

// Configure pdf.js worker — use Vite's ?url import for the bundled worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

/**
 * PDF Viewer panel — continuous vertical scroll, lazy page rendering.
 *
 * All pages are stacked in a scroll container. An IntersectionObserver
 * triggers rendering when a page scrolls into (or near) the viewport, and
 * releases resources when it scrolls far away.
 *
 * Features:
 *   - Text selection via pdf.js TextLayer
 *   - Cmd/Ctrl+Click → inverse search (jump to LaTeX source line)
 *   - Forward search highlight (editor → PDF)
 *   - Zoom +/- with crisp HiDPI rendering
 *
 * Props:
 *   onCompile()     — trigger compilation
 *   onInverseSearch({ line }) — called on Cmd+click
 *   forwardHighlight — { page, y, height }
 */
export default function PdfViewer({ onCompile, onInverseSearch, forwardHighlight }) {
  const [pdfData, setPdfData] = useState(null);
  const [compiling, setCompiling] = useState(false);
  const [errors, setErrors] = useState([]);
  const [zoom, setZoom] = useState(100);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1); // derived from scroll
  const pdfDocRef = useRef(null);
  const panelRef = useRef(null);   // outer .pdf-panel — its width is the true container width
  const viewerRef = useRef(null);
  const pageContainerRefs = useRef([]); // DOM refs per page
  const renderStateRef = useRef(new Map()); // pageNum -> 'rendering' | 'done'

  // Native page width at scale=1 (set once when doc loads)
  const nativePageWidthRef = useRef(0);
  // Only auto-fit on the very first PDF load, not on every recompile
  const didInitialFitRef = useRef(false);

  // SyncTeX
  const synctexInfoRef = useRef(null);
  const [hasSynctex, setHasSynctex] = useState(false);
  const [highlightInfo, setHighlightInfo] = useState(null); // { page, top, height }

  // ─── Compile ───
  const handleCompile = useCallback(async () => {
    setCompiling(true);
    setErrors([]);
    try {
      const result = await onCompile();
      if (result?.success && result.pdfData) {
        setPdfData(result.pdfData);
        if (result.synctexPath) {
          synctexInfoRef.current = {
            synctexPath: result.synctexPath,
            texPath: result.texPath,
          };
          setHasSynctex(true);
        }
      } else {
        setErrors(result?.errors || ['Compilation failed']);
      }
    } catch (err) {
      setErrors([err.message]);
    } finally {
      setCompiling(false);
    }
  }, [onCompile]);

  // ─── Load the PDF document and set up pages ───
  useEffect(() => {
    if (!pdfData) return;
    let cancelled = false;

    async function loadDoc() {
      const data = Uint8Array.from(atob(pdfData), c => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data }).promise;
      if (cancelled) { doc.destroy(); return; }
      pdfDocRef.current = doc;
      setTotalPages(doc.numPages);
      renderStateRef.current = new Map();

      // Store the native page width (at scale=1) for fit-to-width calculation
      const firstPage = await doc.getPage(1);
      const vp = firstPage.getViewport({ scale: 1 });
      nativePageWidthRef.current = vp.width;

      // Auto-fit on first load so the page doesn't overflow a narrow panel.
      // Render scale is (zoom/100)*1.5, so at zoom=100 a US-letter page is
      // ~900px wide — bigger than the panel once the editor is also on
      // screen. Fit-to-width gives a sane default and the user can still
      // zoom in / out from there.
      const panel = panelRef.current;
      const viewer = viewerRef.current;
      if (panel && viewer && !didInitialFitRef.current) {
        const cs = window.getComputedStyle(viewer);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        // Use panel.clientWidth (true container width) rather than
        // viewer.clientWidth which can expand with PDF content when the
        // flex parent lacks min-width:0.
        const availableWidth = panel.clientWidth - padL - padR;
        if (availableWidth > 0 && vp.width > 0) {
          const fitZoom = Math.floor((availableWidth / (vp.width * 1.5)) * 100);
          setZoom(Math.min(200, Math.max(25, fitZoom)));
          didInitialFitRef.current = true;
        }
      }
    }

    loadDoc();
    return () => { cancelled = true; };
  }, [pdfData]);

  // ─── Render a single page into its container ───
  const renderPage = useCallback(async (pageNum) => {
    const doc = pdfDocRef.current;
    const container = pageContainerRefs.current[pageNum - 1];
    if (!doc || !container) return;
    if (renderStateRef.current.get(pageNum) === 'rendering') return;
    renderStateRef.current.set(pageNum, 'rendering');

    try {
      const page = await doc.getPage(pageNum);
      // Check if still mounted / container still exists
      if (!pageContainerRefs.current[pageNum - 1]) return;

      const scale = (zoom / 100) * 1.5;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;

      // ── Canvas ──
      let canvas = container.querySelector('canvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        container.insertBefore(canvas, container.firstChild);
      }
      const ctx = canvas.getContext('2d');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.style.display = 'block';

      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
      try {
        await page.render({ canvasContext: ctx, viewport, transform }).promise;
      } catch (err) {
        if (err?.name === 'RenderingCancelledException') return;
        throw err;
      }

      // ── Text layer ──
      let textDiv = container.querySelector('.textLayer');
      if (!textDiv) {
        textDiv = document.createElement('div');
        textDiv.className = 'textLayer';
        container.appendChild(textDiv);
      }
      textDiv.innerHTML = '';
      textDiv.style.width = `${Math.floor(viewport.width)}px`;
      textDiv.style.height = `${Math.floor(viewport.height)}px`;
      textDiv.style.setProperty('--scale-factor', String(scale));

      const textContent = await page.getTextContent();
      const tl = new TextLayer({
        textContentSource: textContent,
        container: textDiv,
        viewport,
      });
      await tl.render();

      // Size the container so scroll height is stable
      container.style.width = `${Math.floor(viewport.width)}px`;
      container.style.height = `${Math.floor(viewport.height)}px`;

      renderStateRef.current.set(pageNum, 'done');
    } catch (err) {
      console.error(`[PdfViewer] Error rendering page ${pageNum}:`, err);
      renderStateRef.current.delete(pageNum);
    }
  }, [zoom]);

  // ─── Set placeholder sizes for pages that haven't rendered yet ───
  // This keeps the scroll height stable so scrolling feels correct.
  useEffect(() => {
    if (!pdfDocRef.current || totalPages === 0) return;
    let cancelled = false;

    async function setPlaceholders() {
      const doc = pdfDocRef.current;
      const scale = (zoom / 100) * 1.5;

      for (let i = 1; i <= totalPages; i++) {
        if (cancelled) return;
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale });
        const el = pageContainerRefs.current[i - 1];
        if (el) {
          el.style.width = `${Math.floor(vp.width)}px`;
          el.style.height = `${Math.floor(vp.height)}px`;
        }
      }
    }

    // Clear old renders when zoom changes — pages need to re-render at new scale
    renderStateRef.current = new Map();
    pageContainerRefs.current.forEach((el) => {
      if (el) {
        const canvas = el.querySelector('canvas');
        if (canvas) canvas.remove();
        const textDiv = el.querySelector('.textLayer');
        if (textDiv) textDiv.remove();
      }
    });

    setPlaceholders();
    return () => { cancelled = true; };
  }, [totalPages, zoom]);

  // ─── IntersectionObserver: render pages as they enter viewport ───
  useEffect(() => {
    if (totalPages === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = Number(entry.target.dataset.page);
            if (pageNum && renderStateRef.current.get(pageNum) !== 'done') {
              renderPage(pageNum);
            }
          }
        }
      },
      {
        root: viewerRef.current,
        rootMargin: '200px 0px', // start rendering 200px before page scrolls in
        threshold: 0,
      }
    );

    pageContainerRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [totalPages, zoom, renderPage]);

  // ─── Track current page from scroll position ───
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || totalPages === 0) return;

    const onScroll = () => {
      const viewerRect = viewer.getBoundingClientRect();
      const viewerMid = viewerRect.top + viewerRect.height / 2;
      let closest = 1;
      let closestDist = Infinity;

      for (let i = 0; i < pageContainerRefs.current.length; i++) {
        const el = pageContainerRefs.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const dist = Math.abs(mid - viewerMid);
        if (dist < closestDist) {
          closestDist = dist;
          closest = i + 1;
        }
      }
      setCurrentPage(closest);
    };

    viewer.addEventListener('scroll', onScroll, { passive: true });
    return () => viewer.removeEventListener('scroll', onScroll);
  }, [totalPages]);

  // ─── Inverse search: Cmd/Ctrl+Click on PDF → jump to source line ───
  const handlePdfClick = useCallback(async (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!window.api?.synctex || !synctexInfoRef.current) return;
    e.preventDefault();

    // Walk up to find the page container to know which page was clicked
    let pageContainer = e.target;
    while (pageContainer && !pageContainer.dataset.page) {
      pageContainer = pageContainer.parentElement;
    }
    if (!pageContainer) return;
    const pageNum = Number(pageContainer.dataset.page);

    const canvas = pageContainer.querySelector('canvas');
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scale = (zoom / 100) * 1.5;
    const pdfX = (e.clientX - rect.left) / scale;
    const pdfY = (e.clientY - rect.top) / scale;

    try {
      const result = await window.api.synctex.inverse({
        synctexPath: synctexInfoRef.current.synctexPath,
        page: pageNum,
        x: pdfX,
        y: pdfY,
      });
      if (result?.line && onInverseSearch) {
        onInverseSearch({ line: result.line, column: result.column || 0 });
      }
    } catch (err) {
      console.error('[SyncTeX] Inverse search failed:', err);
    }
  }, [zoom, onInverseSearch]);

  // ─── Forward search: highlight + scroll to position in PDF ───
  useEffect(() => {
    if (!forwardHighlight || !pdfData || totalPages === 0) return;
    const { page, y, height } = forwardHighlight;

    const scale = (zoom / 100) * 1.5;
    setHighlightInfo({
      page: page || 1,
      top: y * scale,
      height: Math.max((height || 14) * scale, 4),
    });

    // Scroll the page container into view
    const el = pageContainerRefs.current[(page || 1) - 1];
    if (el) {
      // Scroll so the highlight y-offset is roughly centered
      const viewer = viewerRef.current;
      if (viewer) {
        const containerTop = el.offsetTop;
        const targetScroll = containerTop + y * scale - viewer.clientHeight / 2;
        viewer.scrollTo({ top: targetScroll, behavior: 'smooth' });
      }
    }

    const timer = setTimeout(() => setHighlightInfo(null), 2500);
    return () => clearTimeout(timer);
  }, [forwardHighlight]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Fit to width: scale so the page fills the viewer horizontally ───
  // Pure calculation from refs + DOM — no dependency on `zoom` state,
  // so it converges in a single click regardless of current zoom level.
  //
  // IMPORTANT: measure panelRef (the outer .pdf-panel flex item) instead of
  // viewerRef.  When zoom is large the PDF pages are wider than the panel, and
  // without min-width:0 on the flex item the browser can report
  // viewer.clientWidth ≈ page width instead of container width, making
  // fitZoom ≈ currentZoom-1 (off-by-one loop that never converges).
  const handleFitWidth = useCallback(() => {
    const panel = panelRef.current;
    const viewer = viewerRef.current;
    const nativeW = nativePageWidthRef.current;
    if (!panel || !viewer || !nativeW || nativeW <= 0) return;

    const cs = window.getComputedStyle(viewer);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    // panel.clientWidth is always the true container width because .pdf-panel
    // is constrained by the flex layout (min-width:0 in CSS).
    const availableWidth = panel.clientWidth - padL - padR;
    if (availableWidth <= 0) return;

    // pageWidth at zoom Z = nativeW * (Z / 100) * 1.5
    // Solve for Z so that pageWidth = availableWidth:
    //   Z = availableWidth / (nativeW * 1.5) * 100
    const fitZoom = Math.floor((availableWidth / (nativeW * 1.5)) * 100);
    setZoom(Math.min(200, Math.max(25, fitZoom)));
  }, []);

  // ─── Scroll to specific page (from page indicator click) ───
  const scrollToPage = useCallback((pageNum) => {
    const el = pageContainerRefs.current[pageNum - 1];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // ─── Build page container refs array ───
  const setPageRef = useCallback((pageNum, el) => {
    pageContainerRefs.current[pageNum - 1] = el;
  }, []);

  return (
    <div className="pdf-panel" ref={panelRef}>
      <div className="pdf-toolbar">
        <button
          onClick={handleCompile}
          disabled={compiling}
          style={{
            background: 'var(--bg-hover)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', padding: '3px 10px', borderRadius: 3,
            cursor: 'pointer', fontSize: 11,
          }}
        >
          {compiling ? 'Compiling...' : 'Compile (Cmd+B)'}
        </button>

        {totalPages > 0 && (
          <>
            <span
              style={{ cursor: 'pointer' }}
              onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
              title="Previous page"
            >
              &larr;
            </span>
            <span>{currentPage} / {totalPages}</span>
            <span
              style={{ cursor: 'pointer' }}
              onClick={() => scrollToPage(Math.min(totalPages, currentPage + 1))}
              title="Next page"
            >
              &rarr;
            </span>
            <span style={{ margin: '0 4px' }}>|</span>
          </>
        )}

        <button onClick={() => setZoom(z => Math.max(50, z - 10))}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          -
        </button>
        <span>{zoom}%</span>
        <button onClick={() => setZoom(z => Math.min(200, z + 10))}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          +
        </button>
        <button
          onClick={handleFitWidth}
          title="Fit page width to panel"
          style={{
            background: 'none', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
            padding: '1px 6px', borderRadius: 3, fontSize: 10,
            marginLeft: 2,
          }}
        >
          Fit
        </button>

        {hasSynctex && (
          <span style={{
            marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)',
            opacity: 0.6, userSelect: 'none',
          }}>
            SyncTeX &middot; Cmd+Click to jump
          </span>
        )}
      </div>

      <div className="pdf-viewer" ref={viewerRef} onClick={handlePdfClick}>
        {errors.length > 0 ? (
          <div style={{ padding: 20, color: 'var(--red)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Compilation Errors:</div>
            {errors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        ) : pdfData && totalPages > 0 ? (
          <div className="pdf-pages-stack">
            {Array.from({ length: totalPages }, (_, i) => {
              const pageNum = i + 1;
              return (
                <div
                  key={pageNum}
                  className="pdf-page-container"
                  data-page={pageNum}
                  ref={(el) => setPageRef(pageNum, el)}
                >
                  {/* canvas + textLayer are added dynamically by renderPage */}
                  {highlightInfo && highlightInfo.page === pageNum && (
                    <div
                      className="synctex-highlight"
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: highlightInfo.top,
                        height: highlightInfo.height,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--text-muted)', fontSize: 13, gap: 12,
          }}>
            <div style={{ fontSize: 40, opacity: 0.3 }}>PDF</div>
            <div>Click "Compile" to preview your document</div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>
              Requires pdflatex, xelatex, or tectonic installed
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
