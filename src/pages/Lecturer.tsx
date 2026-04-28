import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import {
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
    <main className="classroom-theme min-h-screen bg-classroom-muted text-classroom-surface-foreground">
      {/* Top bar — Classroom-style */}
      <header className="flex items-center justify-between px-6 py-3 bg-classroom-surface border-b border-classroom-border shadow-[var(--shadow-classroom)] sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-lg bg-[image:var(--gradient-classroom)] grid place-items-center shadow-[var(--shadow-classroom)]">
              <GraduationCap className="size-5 text-classroom-foreground" />
            </div>
            <div className="leading-tight">
              <div className="text-base font-semibold text-classroom-surface-foreground">Lecturer Classroom</div>
              <div className="text-[11px] text-classroom-muted-foreground">Present · Annotate · Record</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="pdf-upload">
            <input id="pdf-upload" type="file" accept="application/pdf" className="hidden" onChange={onUpload} />
            <Button asChild size="sm" className="gap-2 cursor-pointer bg-classroom hover:bg-classroom/90 text-classroom-foreground">
              <span><FileUp className="size-4" /> {pdf ? "Replace PDF" : "Upload PDF"}</span>
            </Button>
          </label>
          {pdf && (
            <>
              <Button
                size="sm"
                variant={annotateActive ? "default" : "outline"}
                onClick={() => setAnnotateActive((a) => !a)}
                className={`gap-2 ${annotateActive ? "bg-classroom-secondary hover:bg-classroom-secondary/90 text-classroom-foreground" : "border-classroom-border bg-classroom-surface text-classroom-surface-foreground hover:bg-classroom-muted"}`}
              >
                <Pencil className="size-4" />
                {annotateActive ? "Hide annotations" : "Annotate"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={enterFullscreen}
                className="gap-2 border-classroom-border bg-classroom-surface text-classroom-surface-foreground hover:bg-classroom-muted"
              >
                <Maximize2 className="size-4" /> Fullscreen
              </Button>
            </>
          )}
        </div>
      </header>

      {!pdf ? (
        <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
          {/* Hero "course banner" — Classroom signature */}
          <div className="relative overflow-hidden rounded-2xl bg-[image:var(--gradient-classroom-hero)] text-classroom-foreground shadow-[var(--shadow-classroom-lg)] p-8 sm:p-10">
            <div className="absolute inset-0 opacity-20 pointer-events-none"
                 style={{ backgroundImage: "radial-gradient(circle at 90% 10%, hsl(0 0% 100% / 0.4), transparent 40%), radial-gradient(circle at 10% 90%, hsl(0 0% 100% / 0.25), transparent 50%)" }} />
            <div className="relative">
              <div className="text-xs uppercase tracking-widest opacity-90 mb-2">My Classroom</div>
              <h1 className="text-3xl sm:text-4xl font-bold leading-tight">Welcome back, Professor</h1>
              <p className="mt-2 text-sm sm:text-base opacity-95 max-w-xl">
                Upload your slides to start a new lesson. Present, annotate, and record — all in one place.
              </p>
            </div>
          </div>

          {/* Quick-actions grid (Classroom card style) */}
          <section className="grid sm:grid-cols-3 gap-4">
            <ClassroomStat icon={<BookOpen className="size-5" />} label="Lessons" value="—" tint="green" />
            <ClassroomStat icon={<Users className="size-5" />} label="Audience" value="Live" tint="blue" />
            <ClassroomStat icon={<Calendar className="size-5" />} label="Today" value={new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} tint="amber" />
          </section>

          {/* Upload card — Material style */}
          <Card className="bg-classroom-surface border-classroom-border shadow-[var(--shadow-classroom)] p-0 overflow-hidden">
            <div className="px-6 py-4 border-b border-classroom-border flex items-center gap-2">
              <BookOpen className="size-4 text-classroom" />
              <h2 className="text-sm font-semibold text-classroom-surface-foreground">Start a new lesson</h2>
            </div>
            <div className="p-8">
              <label htmlFor="pdf-upload-empty" className="block">
                <input id="pdf-upload-empty" type="file" accept="application/pdf" className="hidden" onChange={onUpload} />
                <div className="border-2 border-dashed border-classroom-border rounded-xl p-10 text-center cursor-pointer hover:border-classroom hover:bg-classroom/5 transition-colors">
                  <div className="size-14 rounded-full bg-classroom/10 grid place-items-center mx-auto mb-4">
                    <FileUp className="size-6 text-classroom" />
                  </div>
                  <div className="text-base font-semibold text-classroom-surface-foreground">Choose your PDF slides</div>
                  <p className="text-sm text-classroom-muted-foreground mt-1">
                    Drop a file here or click to browse
                  </p>
                  <Button asChild size="lg" className="gap-2 mt-5 cursor-pointer bg-classroom hover:bg-classroom/90 text-classroom-foreground">
                    <span><FileUp className="size-5" /> Upload PDF</span>
                  </Button>
                </div>
              </label>
              <p className="text-xs text-classroom-muted-foreground text-center pt-4">
                🔒 Files stay on your device — nothing is uploaded.
              </p>
            </div>
          </Card>
        </div>
      ) : (
        <div className="p-4 h-[calc(100vh-65px)]">
          <section className="relative flex flex-col h-full">
            <div
              ref={stageRef}
              className="relative flex-1 rounded-xl bg-black/95 flex items-center justify-center overflow-hidden shadow-[var(--shadow-classroom-lg)] border border-classroom-border"
            >
              <canvas ref={canvasRef} className="shadow-2xl bg-white" />
            </div>
            <p className="text-xs text-classroom-muted-foreground mt-2 text-center">
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

const ClassroomStat = ({
  icon,
  label,
  value,
  tint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tint: "green" | "blue" | "amber";
}) => {
  const tintClass =
    tint === "green"
      ? "bg-classroom/10 text-classroom"
      : tint === "blue"
      ? "bg-classroom-secondary/10 text-classroom-secondary"
      : "bg-amber-100 text-amber-600";
  return (
    <div className="bg-classroom-surface border border-classroom-border rounded-xl p-4 flex items-center gap-3 shadow-[var(--shadow-classroom)] hover:shadow-[var(--shadow-classroom-lg)] transition-shadow">
      <div className={`size-10 rounded-lg grid place-items-center ${tintClass}`}>{icon}</div>
      <div className="leading-tight">
        <div className="text-xs text-classroom-muted-foreground">{label}</div>
        <div className="text-base font-semibold text-classroom-surface-foreground">{value}</div>
      </div>
    </div>
  );
};

export default Lecturer;
