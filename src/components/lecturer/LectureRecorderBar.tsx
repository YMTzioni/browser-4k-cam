import { useEffect, useRef, useState, forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Circle,
  Square,
  Pause,
  Play,
  Mic,
  MicOff,
  Camera,
  CameraOff,
  Download,
  ChevronLeft,
  ChevronRight,
  Settings2,
  Sparkles,
  RectangleHorizontal,
  Circle as CircleIcon,
  Focus,
} from "lucide-react";
import { useCameraStream, type BackgroundMode } from "@/hooks/useCameraStream";

export type CameraShape = "rounded" | "circle" | "rectangle";

const formatTime = (s: number) => {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
};

type CameraBubblePosition = {
  x: number;
  y: number;
  width: number;
  /** Bubble bounding box in viewport CSS pixels (for compositing). */
  rect: DOMRect | null;
};

type Props = {
  showCamera: boolean;
  onToggleCamera: () => void;
  /** PDF canvas to record. */
  pdfCanvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  /** Stage element (used as the source coordinate space). */
  stageRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Returns the current annotation canvas (may be null when overlay is hidden). */
  getAnnotationCanvas: () => HTMLCanvasElement | null;
  /** Slide navigation. */
  page: number;
  totalPages: number;
  onPrevPage: () => void;
  onNextPage: () => void;
};

/**
 * Floating recorder toolbar for the Lecturer workspace.
 *
 * Recording strategy: we composite the PDF canvas + annotation canvas + camera
 * bubble into an offscreen canvas at 30fps and capture *that* stream. This
 * means:
 *   • No screen-share picker / tab-share prompt.
 *   • The toolbar itself is NOT included in the recording.
 *   • Slide navigation buttons & camera bubble are part of the workspace.
 */
export const LectureRecorderBar = ({
  showCamera,
  onToggleCamera,
  pdfCanvasRef,
  stageRef,
  getAnnotationCanvas,
  page,
  totalPages,
  onPrevPage,
  onNextPage,
}: Props) => {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [withMic, setWithMic] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [converting, setConverting] = useState(false);

  // Camera appearance options
  const [bgMode, setBgMode] = useState<BackgroundMode>("none");
  const [blurAmount, setBlurAmount] = useState(12);
  const [shape, setShape] = useState<CameraShape>("rounded");
  const [bubbleWidth, setBubbleWidth] = useState(240);
  const [mirror, setMirror] = useState(true);
  const [autoCenter, setAutoCenter] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const composerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const composerStreamRef = useRef<MediaStream | null>(null);
  const drawIntervalRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const cameraBubbleRef = useRef<HTMLDivElement | null>(null);
  const shapeRef = useRef<CameraShape>(shape);
  const mirrorRef = useRef<boolean>(mirror);
  useEffect(() => { shapeRef.current = shape; }, [shape]);
  useEffect(() => { mirrorRef.current = mirror; }, [mirror]);

  const { rawStream, processedStream, error: camError, requestCamera, stopCamera } = useCameraStream({
    backgroundMode: bgMode,
    blurAmount,
    autoCenter,
  });
  const camStream = processedStream ?? rawStream;
  const camPreviewRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (showCamera) requestCamera();
    else stopCamera();
  }, [showCamera, requestCamera, stopCamera]);

  useEffect(() => {
    if (camError) toast.error(camError, { duration: 5000 });
  }, [camError]);

  useEffect(() => {
    if (camPreviewRef.current && camStream) {
      camPreviewRef.current.srcObject = camStream;
      camPreviewRef.current.play().catch(() => {});
    }
  }, [camStream]);

  useEffect(() => () => cleanup(), []);

  const cleanup = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (drawIntervalRef.current) window.clearInterval(drawIntervalRef.current);
    drawIntervalRef.current = null;
    composerStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    composerStreamRef.current = null;
    micStreamRef.current = null;
  };

  // Prefer MP4/H.264 directly from MediaRecorder when the browser supports it
  // (Safari + recent Chrome). This avoids the costly WebM→MP4 transcode entirely.
  const pickMimeType = () => {
    const candidates = [
      "video/mp4;codecs=h264,aac",
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "video/webm";
  };

  const start = async () => {
    const stage = stageRef.current;
    const pdf = pdfCanvasRef.current;
    if (!stage || !pdf) {
      toast.error("PDF stage not ready");
      return;
    }
    try {
      // Composer canvas sized to the stage (in device pixels for sharpness).
      const dpr = window.devicePixelRatio || 1;
      const stageRect = stage.getBoundingClientRect();
      const composer = document.createElement("canvas");
      composer.width = Math.round(stageRect.width * dpr);
      composer.height = Math.round(stageRect.height * dpr);
      composerCanvasRef.current = composer;
      const cctx = composer.getContext("2d")!;

      const drawFrame = () => {
        const stageEl = stageRef.current;
        if (!stageEl) return;
        const sRect = stageEl.getBoundingClientRect();
        // Resize composer if stage changed
        if (
          composer.width !== Math.round(sRect.width * dpr) ||
          composer.height !== Math.round(sRect.height * dpr)
        ) {
          composer.width = Math.round(sRect.width * dpr);
          composer.height = Math.round(sRect.height * dpr);
        }

        // Background
        cctx.fillStyle = "#000";
        cctx.fillRect(0, 0, composer.width, composer.height);

        // PDF canvas (centered as it appears on screen)
        const pdfEl = pdfCanvasRef.current;
        if (pdfEl) {
          const pRect = pdfEl.getBoundingClientRect();
          const dx = (pRect.left - sRect.left) * dpr;
          const dy = (pRect.top - sRect.top) * dpr;
          const dw = pRect.width * dpr;
          const dh = pRect.height * dpr;
          try {
            cctx.drawImage(pdfEl, dx, dy, dw, dh);
          } catch {
            /* ignore mid-render */
          }
        }

        // Annotation canvas (covers full viewport — clip to stage area)
        const annEl = getAnnotationCanvas();
        if (annEl) {
          const aRect = annEl.getBoundingClientRect();
          const dx = (aRect.left - sRect.left) * dpr;
          const dy = (aRect.top - sRect.top) * dpr;
          const dw = aRect.width * dpr;
          const dh = aRect.height * dpr;
          try {
            cctx.drawImage(annEl, dx, dy, dw, dh);
          } catch {
            /* ignore */
          }
        }

        // Camera bubble
        const bubble = cameraBubbleRef.current;
        const video = camPreviewRef.current;
        if (bubble && video && video.readyState >= 2) {
          const bRect = bubble.getBoundingClientRect();
          const dx = (bRect.left - sRect.left) * dpr;
          const dy = (bRect.top - sRect.top) * dpr;
          const dw = bRect.width * dpr;
          const dh = bRect.height * dpr;
          cctx.save();
          const sh = shapeRef.current;
          if (sh === "circle") {
            const cx = dx + dw / 2;
            const cy = dy + dh / 2;
            const r = Math.min(dw, dh) / 2;
            cctx.beginPath();
            cctx.arc(cx, cy, r, 0, Math.PI * 2);
            cctx.closePath();
          } else if (sh === "rectangle") {
            cctx.beginPath();
            cctx.rect(dx, dy, dw, dh);
          } else {
            roundRectPath(cctx, dx, dy, dw, dh, 12 * dpr);
          }
          cctx.clip();
          try {
            if (mirrorRef.current) {
              cctx.translate(dx + dw, dy);
              cctx.scale(-1, 1);
              cctx.drawImage(video, 0, 0, dw, dh);
            } else {
              cctx.drawImage(video, dx, dy, dw, dh);
            }
          } catch {
            /* ignore */
          }
          cctx.restore();
          // Ring
          cctx.lineWidth = 2 * dpr;
          cctx.strokeStyle = "hsl(var(--primary))";
          if (sh === "circle") {
            const cx = dx + dw / 2;
            const cy = dy + dh / 2;
            const r = Math.min(dw, dh) / 2;
            cctx.beginPath();
            cctx.arc(cx, cy, r, 0, Math.PI * 2);
            cctx.stroke();
          } else if (sh === "rectangle") {
            cctx.strokeRect(dx, dy, dw, dh);
          } else {
            roundRectPath(cctx, dx, dy, dw, dh, 12 * dpr);
            cctx.stroke();
          }
        }

        
      };
      // Use a fixed-rate timer instead of rAF — rAF is throttled when the tab
      // loses focus or when expensive layout work happens, which causes the
      // recorded video to "skip". setInterval gives us a steady cadence.
      const FPS = 30;
      drawFrame();
      drawIntervalRef.current = window.setInterval(drawFrame, 1000 / FPS);

      const composerStream = composer.captureStream(FPS);
      composerStreamRef.current = composerStream;

      // Build a single mixed audio track via WebAudio so the recorder receives
      // a continuous, gap-free audio stream (avoids muted segments when tracks
      // are added/removed or briefly stall).
      const audioTracks: MediaStreamTrack[] = [];
      if (withMic) {
        try {
          micStreamRef.current = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
          });
          const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
          audioCtxRef.current = ctx;
          const dest = ctx.createMediaStreamDestination();
          const src = ctx.createMediaStreamSource(micStreamRef.current);
          src.connect(dest);
          dest.stream.getAudioTracks().forEach((t) => audioTracks.push(t));
        } catch {
          toast.error("Microphone denied — recording without mic");
        }
      }

      const tracks: MediaStreamTrack[] = [
        ...composerStream.getVideoTracks(),
        ...audioTracks,
      ];
      const stream = new MediaStream(tracks);

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 6_000_000,
        audioBitsPerSecond: 128_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      recorder.onstop = () => {
        const containerType = mimeType.startsWith("video/mp4") ? "video/mp4" : "video/webm";
        const blob = new Blob(chunksRef.current, { type: containerType });
        setPreviewBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
        cleanup();
      };

      // Larger timeslice = fewer chunk boundaries = smoother playback.
      recorder.start(2000);
      recorderRef.current = recorder;
      setRecording(true);
      setPaused(false);
      setElapsed(0);
      setPreviewUrl(null);
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
      toast.success("Recording started");
    } catch (err) {
      console.error(err);
      toast.error("Could not start recording");
      cleanup();
    }
  };

  const togglePause = () => {
    const r = recorderRef.current;
    if (!r) return;
    if (r.state === "recording") {
      r.pause();
      setPaused(true);
      if (timerRef.current) window.clearInterval(timerRef.current);
    } else if (r.state === "paused") {
      r.resume();
      setPaused(false);
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    setRecording(false);
    setPaused(false);
    if (timerRef.current) window.clearInterval(timerRef.current);
    toast.success("Recording saved");
  };

  const triggerDownload = (url: string, ext: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `lecture-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    a.click();
  };

  const downloadWebm = () => {
    if (previewUrl) triggerDownload(previewUrl, "webm");
  };

  const downloadMp4 = async () => {
    if (!previewBlob) return;
    // Fast path: the recorder already produced MP4 — just download it.
    if (previewBlob.type === "video/mp4" || previewBlob.type.startsWith("video/mp4")) {
      const url = URL.createObjectURL(previewBlob);
      triggerDownload(url, "mp4");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success("MP4 ready");
      return;
    }
    setConverting(true);
    const t = toast.loading("Converting to MP4…");
    try {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { fetchFile } = await import("@ffmpeg/util");
      const ffmpeg = new FFmpeg();
      const base = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
      await ffmpeg.load({
        coreURL: `${base}/ffmpeg-core.js`,
        wasmURL: `${base}/ffmpeg-core.wasm`,
      });
      await ffmpeg.writeFile("in.webm", await fetchFile(previewBlob));
      // Use ultrafast preset + higher CRF for ~3-5x faster encoding in the
      // browser. Quality is still very good for slide+webcam content.
      await ffmpeg.exec([
        "-i", "in.webm",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-crf", "26",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "out.mp4",
      ]);
      const data = (await ffmpeg.readFile("out.mp4")) as Uint8Array;
      const buf = new Uint8Array(data).buffer;
      const mp4Blob = new Blob([buf], { type: "video/mp4" });
      const url = URL.createObjectURL(mp4Blob);
      triggerDownload(url, "mp4");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success("MP4 ready", { id: t });
    } catch (err) {
      console.error(err);
      toast.error("MP4 conversion failed — downloading WebM instead", { id: t });
      downloadWebm();
    } finally {
      setConverting(false);
    }
  };

  return (
    <>
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40">
        <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-card/95 backdrop-blur border border-border shadow-xl">
          {/* Slide navigation */}
          <Button
            size="icon"
            variant="ghost"
            onClick={onPrevPage}
            disabled={page <= 1 || totalPages === 0}
            title="Previous slide"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm font-mono tabular-nums px-1 min-w-[60px] text-center">
            {totalPages > 0 ? `${page} / ${totalPages}` : "—"}
          </span>
          <Button
            size="icon"
            variant="ghost"
            onClick={onNextPage}
            disabled={page >= totalPages || totalPages === 0}
            title="Next slide"
          >
            <ChevronRight className="size-4" />
          </Button>

          <div className="w-px h-6 bg-border mx-1" />

          {!recording ? (
            <Button onClick={start} size="sm" className="gap-2 bg-[image:var(--gradient-primary)] text-primary-foreground">
              <Circle className="size-4" fill="currentColor" /> Record
            </Button>
          ) : (
            <>
              <Button onClick={togglePause} size="sm" variant="secondary" className="gap-2">
                {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button onClick={stop} size="sm" variant="destructive" className="gap-2">
                <Square className="size-4" fill="currentColor" /> Stop
              </Button>
            </>
          )}

          <div className="w-px h-6 bg-border mx-1" />

          <span className="font-mono text-sm tabular-nums w-14 text-center">
            {formatTime(elapsed)}
          </span>
          {recording && (
            <span className="flex items-center gap-1.5 text-xs text-destructive">
              <span className={`size-2 rounded-full bg-destructive ${paused ? "" : "animate-pulse"}`} />
              {paused ? "PAUSED" : "REC"}
            </span>
          )}

          <div className="w-px h-6 bg-border mx-1" />

          <Button
            size="icon"
            variant={withMic ? "default" : "secondary"}
            onClick={() => setWithMic((m) => !m)}
            disabled={recording}
            title="Microphone"
          >
            {withMic ? <Mic className="size-4" /> : <MicOff className="size-4" />}
          </Button>
          <Button
            size="icon"
            variant={showCamera ? "default" : "secondary"}
            onClick={onToggleCamera}
            title="Camera bubble"
          >
            {showCamera ? <Camera className="size-4" /> : <CameraOff className="size-4" />}
          </Button>
          <Button
            size="icon"
            variant={autoCenter ? "default" : "secondary"}
            onClick={() => setAutoCenter((v) => !v)}
            disabled={!showCamera}
            title={autoCenter ? "Auto-center: ON" : "Auto-center: OFF"}
          >
            <Focus className="size-4" />
          </Button>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={!showCamera}
                title="Camera options"
              >
                <Settings2 className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-72 p-4 space-y-4">
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Background
                </Label>
                <div className="grid grid-cols-3 gap-1">
                  <Button
                    size="sm"
                    variant={bgMode === "none" ? "default" : "outline"}
                    onClick={() => setBgMode("none")}
                  >
                    None
                  </Button>
                  <Button
                    size="sm"
                    variant={bgMode === "blur" ? "default" : "outline"}
                    onClick={() => setBgMode("blur")}
                    className="gap-1"
                  >
                    <Sparkles className="size-3" /> Blur
                  </Button>
                  <Button
                    size="sm"
                    variant={mirror ? "default" : "outline"}
                    onClick={() => setMirror((m) => !m)}
                  >
                    Mirror
                  </Button>
                </div>
                {bgMode === "blur" && (
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Blur strength</Label>
                      <span className="text-xs text-muted-foreground tabular-nums">{blurAmount}px</span>
                    </div>
                    <Slider
                      value={[blurAmount]}
                      onValueChange={([v]) => setBlurAmount(v)}
                      min={4}
                      max={30}
                      step={1}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Shape
                </Label>
                <div className="grid grid-cols-3 gap-1">
                  <Button
                    size="sm"
                    variant={shape === "rounded" ? "default" : "outline"}
                    onClick={() => setShape("rounded")}
                    title="Rounded"
                  >
                    <Square className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant={shape === "circle" ? "default" : "outline"}
                    onClick={() => setShape("circle")}
                    title="Circle"
                  >
                    <CircleIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant={shape === "rectangle" ? "default" : "outline"}
                    onClick={() => setShape("rectangle")}
                    title="Rectangle"
                  >
                    <RectangleHorizontal className="size-3.5" />
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Size
                  </Label>
                  <span className="text-xs text-muted-foreground tabular-nums">{bubbleWidth}px</span>
                </div>
                <Slider
                  value={[bubbleWidth]}
                  onValueChange={([v]) => setBubbleWidth(v)}
                  min={140}
                  max={520}
                  step={10}
                />
              </div>
            </PopoverContent>
          </Popover>

          {previewUrl && !recording && (
            <>
              <div className="w-px h-6 bg-border mx-1" />
              <Button
                size="sm"
                onClick={downloadMp4}
                disabled={converting}
                className="gap-2 bg-[image:var(--gradient-primary)] text-primary-foreground"
              >
                <Download className="size-4" />
                {converting ? "Converting…" : "MP4"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={downloadWebm}
                disabled={converting}
                className="gap-2"
              >
                <Download className="size-4" /> WebM
              </Button>
            </>
          )}
        </div>
      </div>

      {showCamera && (
        <DraggableCameraBubble
          ref={cameraBubbleRef}
          videoRef={camPreviewRef}
          hasStream={!!camStream}
          recording={recording}
          shape={shape}
          width={bubbleWidth}
          onWidthChange={setBubbleWidth}
          mirror={mirror}
        />
      )}
    </>
  );
};

const roundRectPath = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};



const DraggableCameraBubble = forwardRef<
  HTMLDivElement,
  {
    videoRef: React.MutableRefObject<HTMLVideoElement | null>;
    hasStream: boolean;
    recording: boolean;
    shape: CameraShape;
    width: number;
    onWidthChange: (w: number) => void;
    mirror: boolean;
  }
>(({ videoRef, hasStream, recording, shape, width, onWidthChange, mirror }, ref) => {
  const [pos, setPos] = useState(() => ({
    x: window.innerWidth - 280,
    y: window.innerHeight - 240,
  }));
  const draggingRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizingRef = useRef<{ startX: number; startW: number } | null>(null);

  // Aspect ratio per shape — circle is 1:1, others 16:9.
  const aspect = shape === "circle" ? 1 : 16 / 9;
  const height = width / aspect;

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (resizingRef.current) {
      const r = resizingRef.current;
      const next = Math.max(140, Math.min(520, r.startW + (e.clientX - r.startX)));
      onWidthChange(next);
      return;
    }
    if (!draggingRef.current) return;
    const d = draggingRef.current;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - width, e.clientX - d.dx)),
      y: Math.max(0, Math.min(window.innerHeight - height, e.clientY - d.dy)),
    });
  };
  const onPointerUp = () => {
    draggingRef.current = null;
    resizingRef.current = null;
  };

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizingRef.current = { startX: e.clientX, startW: width };
  };

  const shapeClass =
    shape === "circle" ? "rounded-full" : shape === "rectangle" ? "rounded-none" : "rounded-xl";

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`fixed z-50 overflow-hidden shadow-2xl ring-2 ring-primary cursor-grab active:cursor-grabbing select-none ${shapeClass}`}
      style={{ left: pos.x, top: pos.y, width, height }}
    >
      {hasStream ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover bg-black pointer-events-none"
          style={mirror ? { transform: "scaleX(-1)" } : undefined}
        />
      ) : (
        <div className="w-full h-full grid place-items-center bg-black/80 text-xs text-muted-foreground">
          Starting camera…
        </div>
      )}
      {recording && (
        <div className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-destructive/90 text-destructive-foreground text-[10px] font-semibold pointer-events-none">
          <span className="size-1.5 rounded-full bg-destructive-foreground animate-pulse" /> REC
        </div>
      )}
      <div
        onPointerDown={startResize}
        className="absolute bottom-0 right-0 size-4 cursor-se-resize bg-primary/80 rounded-tl"
        title="Drag to resize"
      />
    </div>
  );
});
DraggableCameraBubble.displayName = "DraggableCameraBubble";
