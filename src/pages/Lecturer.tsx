import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import {
  ArrowLeft,
  FileUp,
  Maximize2,
  Pencil,
  GraduationCap,
  BookOpen,
  Users,
  Calendar,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  AnnotationOverlay,
  AnnotationOverlayHandle,
} from "@/components/lecturer/AnnotationOverlay";

import { LectureRecorderBar } from "@/components/lecturer/LectureRecorderBar";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

type LoadedPdf = {
  doc: pdfjsLib.PDFDocumentProxy;
  name: string;
  numPages: number;
};

const Lecturer = () => {
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [page, setPage] = useState(1);
  const [annotateActive, setAnnotateActive] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const annotationRef = useRef<AnnotationOverlayHandle | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  // Load PDF
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      setPdf({ doc, name: file.name, numPages: doc.numPages });
      setPage(1);
      
      toast.success(`Loaded ${file.name} (${doc.numPages} pages)`);
    } catch (err) {
      console.error(err);
      toast.error("Could not read this PDF");
    }
  };

  // Render current page into the main canvas
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        renderTaskRef.current?.cancel();
        const pdfPage = await pdf.doc.getPage(page);
        const stage = stageRef.current;
        if (!stage || cancelled) return;
        const stageW = stage.clientWidth;
        const stageH = stage.clientHeight;
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(stageW / baseViewport.width, stageH / baseViewport.height);
        const dpr = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale: scale * dpr });
        const canvas = canvasRef.current!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        const ctx = canvas.getContext("2d")!;
        const task = pdfPage.render({ canvasContext: ctx, viewport, canvas });
        renderTaskRef.current = task;
        await task.promise;
      } catch (err: unknown) {
        const e = err as { name?: string };
        if (e?.name !== "RenderingCancelledException") console.error(err);
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdf, page]);

  // (Thumbnails removed — slide navigation lives in the recorder toolbar.)

  // Re-render on resize
  useEffect(() => {
    const onResize = () => setPage((p) => p);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!pdf) return;
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        setPage((p) => Math.min(pdf.numPages, p + 1));
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        setPage((p) => Math.max(1, p - 1));
      } else if (e.key === "Home") {
        setPage(1);
      } else if (e.key === "End") {
        setPage(pdf.numPages);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pdf]);

  const enterFullscreen = () => {
    const el = document.documentElement;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {
        toast.error("Fullscreen not available");
      });
    }
  };

  return (
    <main className="min-h-screen bg-[image:var(--gradient-bg)]">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/50 backdrop-blur">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/"><ArrowLeft className="size-4 mr-1" /> Recorder</Link>
          </Button>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Presentation className="size-4" />
            <span className="font-semibold text-foreground">Lecturer Workspace</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="pdf-upload">
            <input id="pdf-upload" type="file" accept="application/pdf" className="hidden" onChange={onUpload} />
            <Button asChild variant="secondary" size="sm" className="gap-2 cursor-pointer">
              <span><FileUp className="size-4" /> {pdf ? "Replace PDF" : "Upload PDF"}</span>
            </Button>
          </label>
          {pdf && (
            <>
              <Button
                size="sm"
                variant={annotateActive ? "default" : "secondary"}
                onClick={() => setAnnotateActive((a) => !a)}
                className="gap-2"
              >
                <Pencil className="size-4" />
                {annotateActive ? "Hide annotations" : "Annotate"}
              </Button>
              <Button size="sm" variant="secondary" onClick={enterFullscreen} className="gap-2">
                <Maximize2 className="size-4" /> Fullscreen
              </Button>
            </>
          )}
        </div>
      </header>

      {!pdf ? (
        <div className="flex items-center justify-center px-6 py-24">
          <Card className="max-w-xl w-full p-10 text-center space-y-4 border-dashed border-2">
            <Presentation className="size-10 mx-auto text-primary" />
            <h1 className="text-2xl font-semibold">Present a PDF and record your lecture</h1>
            <p className="text-muted-foreground text-sm">
              Upload your slides, present them fullscreen, draw on top, and capture everything by sharing your browser tab from the Recorder page.
            </p>
            <label htmlFor="pdf-upload-empty">
              <input id="pdf-upload-empty" type="file" accept="application/pdf" className="hidden" onChange={onUpload} />
              <Button asChild size="lg" className="gap-2 cursor-pointer mt-2">
                <span><FileUp className="size-5" /> Choose PDF</span>
              </Button>
            </label>
            <p className="text-xs text-muted-foreground pt-2">
              Files stay on your device — nothing is uploaded.
            </p>
          </Card>
        </div>
      ) : (
        <div className="p-4 h-[calc(100vh-65px)]">
          {/* Stage (full width — slide nav lives in the recorder toolbar) */}
          <section className="relative flex flex-col h-full">
            <div
              ref={stageRef}
              className="relative flex-1 rounded-lg bg-black/90 flex items-center justify-center overflow-hidden"
            >
              <canvas ref={canvasRef} className="shadow-2xl bg-white" />
            </div>
            <p className="text-xs text-muted-foreground mt-2 text-center">
              ← → to navigate · Space for next · use the toolbar below to record this view directly.
            </p>
          </section>
        </div>
      )}

      <AnnotationOverlay
        ref={annotationRef}
        active={annotateActive}
        onClose={() => setAnnotateActive(false)}
      />

      <LectureRecorderBar
        showCamera={showCamera}
        onToggleCamera={() => setShowCamera((s) => !s)}
        pdfCanvasRef={canvasRef}
        stageRef={stageRef}
        getAnnotationCanvas={() => annotationRef.current?.getCanvas() ?? null}
        page={page}
        totalPages={pdf?.numPages ?? 0}
        onPrevPage={() => setPage((p) => Math.max(1, p - 1))}
        onNextPage={() => setPage((p) => Math.min(pdf?.numPages ?? 1, p + 1))}
      />
    </main>
  );
};

export default Lecturer;
