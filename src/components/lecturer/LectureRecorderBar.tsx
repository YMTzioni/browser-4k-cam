import { useEffect, useRef, useState, forwardRef } from "react";
import ffmpegCoreUrl from "@ffmpeg/core?url";
import ffmpegWasmUrl from "@ffmpeg/core/wasm?url";
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
  Volume2,
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
  const [previewMime, setPreviewMime] = useState<string>("");
  const [converting, setConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0); // 0..1
  const [convertElapsed, setConvertElapsed] = useState(0); // seconds
  const [convertStage, setConvertStage] = useState<string>("");
  const convertTimerRef = useRef<number | null>(null);

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
    composerStreamRef.current = null;
    micStreamRef.current = null;
  };

  // PREFER H.264 inside the recording container. When the source video is
  // already H.264, the MP4 export can use `-c:v copy` (a fast remux that takes
  // seconds instead of minutes) instead of re-encoding through libx264 in WASM.
  // Order: H.264 in WebM → H.264 in MP4 → VP9 → VP8 fallbacks.
  const pickMimeType = () => {
    const candidates = [
      "video/webm;codecs=h264,opus",
      "video/webm;codecs=avc1,opus",
      "video/mp4;codecs=h264,aac",
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "video/webm";
  };

  // True when the recorded blob is already H.264 (we can stream-copy video).
  const isH264Container = (mime: string) =>
    /h264|avc1/i.test(mime);

  // Target output resolution: up to 4K (3840 wide), preserving stage aspect.
  const TARGET_OUTPUT_WIDTH = 3840;

  const start = async () => {
    const stage = stageRef.current;
    const pdf = pdfCanvasRef.current;
    if (!stage || !pdf) {
      toast.error("PDF stage not ready");
      return;
    }
    try {
      // Composer canvas sized for 4K output (preserves stage aspect ratio).
      const stageRect = stage.getBoundingClientRect();
      const stageAspect = stageRect.width / stageRect.height;
      const outW = TARGET_OUTPUT_WIDTH;
      const outH = Math.round(outW / stageAspect / 2) * 2; // even number for H.264
      const composer = document.createElement("canvas");
      composer.width = outW;
      composer.height = outH;
      composerCanvasRef.current = composer;
      const cctx = composer.getContext("2d", { alpha: false })!;
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = "high";

      const drawFrame = () => {
        const stageEl = stageRef.current;
        if (!stageEl) return;
        const sRect = stageEl.getBoundingClientRect();
        // Scale factor from CSS px (stage) → composer (4K) px.
        const dpr = composer.width / sRect.width;

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

      // Feed the mic track directly into MediaRecorder. This is more reliable
      // than routing through an AudioContext for a single-input lecture setup,
      // and avoids silent exports on browsers that suspend WebAudio graphs.
      const audioTracks: MediaStreamTrack[] = [];
      if (withMic) {
        try {
          micStreamRef.current = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 2,
              sampleRate: 48000,
            },
          });
          micStreamRef.current.getAudioTracks().forEach((track) => {
            track.enabled = true;
            audioTracks.push(track);
          });
        } catch {
          toast.error("Microphone denied — recording without mic");
        }
      }

      const tracks: MediaStreamTrack[] = [
        ...composerStream.getVideoTracks(),
        ...audioTracks,
      ];
      const stream = new MediaStream(tracks);
      if (withMic && audioTracks.length === 0) {
        toast.error("Microphone was not attached to the recording stream");
      }

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 25_000_000, // ~25 Mbps for 4K
        audioBitsPerSecond: 192_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      recorder.onstop = () => {
        const containerType = mimeType.startsWith("video/mp4") ? "video/mp4" : "video/webm";
        const blob = new Blob(chunksRef.current, { type: containerType });
        setPreviewBlob(blob);
        setPreviewMime(mimeType);
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

  const formatEta = (s: number) => {
    if (!isFinite(s) || s <= 0) return "—";
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const downloadMp4 = async () => {
    if (!previewBlob) return;

    // Fast path: source is already an MP4 container — just rename & download.
    // No FFmpeg, no re-encode. Takes milliseconds.
    if (previewMime.startsWith("video/mp4") || previewBlob.type === "video/mp4") {
      const url = URL.createObjectURL(new Blob([previewBlob], { type: "video/mp4" }));
      triggerDownload(url, "mp4");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success("MP4 ready (instant export)");
      return;
    }

    setConverting(true);
    setConvertProgress(0);
    setConvertElapsed(0);
    const sourceIsH264 = isH264Container(previewMime);
    setConvertStage(sourceIsH264 ? "Preparing fast remux…" : "Preparing MP4 export…");
    const startedAt = Date.now();
    if (convertTimerRef.current) window.clearInterval(convertTimerRef.current);
    convertTimerRef.current = window.setInterval(() => {
      setConvertElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    try {
      setConvertProgress(0.04);
      setConvertStage("Loading encoder modules…");
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { fetchFile } = await import("@ffmpeg/util");

      setConvertProgress(0.1);
      setConvertStage("Starting video encoder…");
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: ffmpegCoreUrl,
        wasmURL: ffmpegWasmUrl,
      });
      setConvertProgress(0.2);

      ffmpeg.on("progress", ({ progress }) => {
        if (typeof progress === "number" && progress >= 0) {
          setConvertProgress(Math.min(0.96, 0.4 + progress * 0.56));
          setConvertStage(sourceIsH264 ? "Remuxing to MP4…" : "Encoding 4K MP4…");
        }
      });

      const inputName = previewBlob.type.includes("mp4") ? "in.mp4" : "in.webm";
      setConvertStage("Preparing source media…");
      setConvertProgress(0.26);
      await ffmpeg.writeFile(inputName, await fetchFile(previewBlob));

      setConvertProgress(0.38);

      // Build args. When the source is already H.264 we stream-copy the video
      // (orders of magnitude faster than libx264 in WASM) and only transcode
      // audio to AAC. Otherwise we re-encode at 4K with a fast preset.
      const args = sourceIsH264
        ? [
            "-i", inputName,
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ac", "2",
            "-movflags", "+faststart",
            "out.mp4",
          ]
        : [
            "-i", inputName,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-tune", "zerolatency",
            "-pix_fmt", "yuv420p",
            "-threads", "0",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ac", "2",
            "-movflags", "+faststart",
            "out.mp4",
          ];

      setConvertStage(sourceIsH264 ? "Remuxing to MP4…" : "Encoding 4K MP4…");
      const exitCode = await ffmpeg.exec(args);
      if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);

      setConvertStage("Finalizing…");
      setConvertProgress(0.98);
      const data = (await ffmpeg.readFile("out.mp4")) as Uint8Array;
      const buf = new Uint8Array(data).buffer;
      const mp4Blob = new Blob([buf], { type: "video/mp4" });
      const url = URL.createObjectURL(mp4Blob);
      triggerDownload(url, "mp4");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setConvertProgress(1);
      setConvertStage("Done");
      const total = Math.floor((Date.now() - startedAt) / 1000);
      toast.success(
        sourceIsH264
          ? `MP4 ready in ${formatEta(total)} (fast remux)`
          : `MP4 ready in ${formatEta(total)}`
      );
    } catch (err) {
      console.error(err);
      toast.error("MP4 conversion failed — downloading WebM instead");
      downloadWebm();
    } finally {
      if (convertTimerRef.current) window.clearInterval(convertTimerRef.current);
      convertTimerRef.current = null;
      setConverting(false);
    }
  };

  // Estimate remaining time from progress + elapsed.
  const convertEta =
    convertProgress > 0.02 && convertProgress < 1
      ? Math.max(0, convertElapsed / convertProgress - convertElapsed)
      : 0;


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
          <MicTestButton disabled={recording} />
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
                title="Export as 4K MP4 (re-encoded for compatibility & audio)"
              >
                <Download className="size-4" />
                {converting ? `${Math.round(convertProgress * 100)}%` : "4K MP4"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={downloadWebm}
                disabled={converting}
                className="gap-2"
                title="Download original WebM (no re-encode, fastest)"
              >
                <Download className="size-4" /> WebM
              </Button>
            </>
          )}
        </div>

        {/* Conversion progress panel */}
        {converting && (
          <div className="mt-2 mx-auto w-[420px] max-w-[92vw] rounded-xl bg-card/95 backdrop-blur border border-border shadow-xl p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold">{convertStage || "Working…"}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {Math.round(convertProgress * 100)}%
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-[image:var(--gradient-primary)] transition-[width] duration-300"
                style={{ width: `${Math.max(2, convertProgress * 100)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono tabular-nums">
              <span>Elapsed: {formatTime(convertElapsed)}</span>
              <span>ETA: {formatEta(convertEta)}</span>
            </div>
          </div>
        )}
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

/**
 * Mic test: opens a popover with a live input level meter and device picker so
 * the lecturer can verify their mic before recording. The mic stream is fully
 * stopped when the popover closes.
 */
const MicTestButton = ({ disabled }: { disabled?: boolean }) => {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(0); // 0..1
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const peakRef = useRef(0);

  const stop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setLevel(0);
    peakRef.current = 0;
  };

  const start = async (id?: string) => {
    stop();
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: id ? { exact: id } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const norm = Math.min(1, rms * 4); // gentle gain for visibility
        peakRef.current = Math.max(peakRef.current * 0.92, norm);
        setLevel(peakRef.current);
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      // Refresh device list (labels become available after permission)
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        setDevices(list.filter((d) => d.kind === "audioinput"));
      } catch { /* ignore */ }
    } catch (err) {
      console.error(err);
      setError("Microphone permission denied");
    }
  };

  useEffect(() => {
    if (open) start(deviceId);
    else stop();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleDeviceChange = (id: string) => {
    setDeviceId(id);
    start(id);
  };

  // Build segmented meter
  const segments = 16;
  const filled = Math.round(level * segments);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          title="Test microphone"
        >
          <Volume2 className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 p-4 space-y-3">
        <div className="space-y-1">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Microphone test
          </Label>
          <p className="text-xs text-muted-foreground">
            Speak to see the input level. Green = good signal.
          </p>
        </div>

        {error ? (
          <div className="text-xs text-destructive">{error}</div>
        ) : (
          <>
            <div className="flex items-center gap-1 h-8">
              {Array.from({ length: segments }).map((_, i) => {
                const active = i < filled;
                const color =
                  i < segments * 0.6
                    ? "bg-green-500"
                    : i < segments * 0.85
                    ? "bg-yellow-500"
                    : "bg-red-500";
                return (
                  <div
                    key={i}
                    className={`flex-1 h-full rounded-sm transition-opacity ${
                      active ? color : "bg-muted"
                    }`}
                    style={{ opacity: active ? 1 : 0.4 }}
                  />
                );
              })}
            </div>
            <div className="text-xs text-muted-foreground">
              {level < 0.02
                ? "No sound detected — try speaking louder"
                : level < 0.6
                ? "Mic is working ✓"
                : "Loud — consider lowering input volume"}
            </div>

            {devices.length > 1 && (
              <div className="space-y-1">
                <Label className="text-xs">Input device</Label>
                <select
                  className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5"
                  value={deviceId ?? devices[0]?.deviceId ?? ""}
                  onChange={(e) => handleDeviceChange(e.target.value)}
                >
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
};
