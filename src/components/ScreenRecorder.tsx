import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { Circle, Square, Download, Monitor, Mic, Video, Camera, PictureInPicture2, Image as ImageIcon, Sparkles } from "lucide-react";
import { useCameraStream, BackgroundMode } from "@/hooks/useCameraStream";

type Resolution = "2160" | "1440" | "1080" | "720";
type CameraMode = "off" | "overlay" | "only";

const RES_MAP: Record<Resolution, { w: number; h: number; label: string }> = {
  "2160": { w: 3840, h: 2160, label: "4K UHD (3840×2160)" },
  "1440": { w: 2560, h: 1440, label: "QHD (2560×1440)" },
  "1080": { w: 1920, h: 1080, label: "Full HD (1920×1080)" },
  "720": { w: 1280, h: 720, label: "HD (1280×720)" },
};

const formatTime = (s: number) => {
  const h = Math.floor(s / 3600).toString().padStart(2, "0");
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${h}:${m}:${sec}`;
};

export const ScreenRecorder = () => {
  const [resolution, setResolution] = useState<Resolution>("2160");
  const [fps, setFps] = useState<"30" | "60">("60");
  const [withMic, setWithMic] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>("off");
  const [bgMode, setBgMode] = useState<BackgroundMode>("none");
  const [blurAmount, setBlurAmount] = useState(12);
  const [bgImageUrl, setBgImageUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pipActive, setPipActive] = useState(false);

  // Bubble position in NORMALIZED coords (0..1) relative to the screen capture
  const [bubblePos, setBubblePos] = useState({ x: 0.76, y: 0.76 }); // top-left
  const [bubbleSize, setBubbleSize] = useState(0.22); // width as fraction of screen width

  const { processedStream: camStream, canvasRef: camCanvasRef, error: camError } = useCameraStream({
    enabled: cameraMode !== "off",
    backgroundMode: bgMode,
    backgroundImageUrl: bgImageUrl,
    blurAmount,
  });

  useEffect(() => {
    if (camError) {
      toast.error(camError, { duration: 6000 });
    }
  }, [camError]);

  const retryCamera = () => {
    // Toggling off then back on re-runs the camera hook
    const prev = cameraMode;
    setCameraMode("off");
    setTimeout(() => setCameraMode(prev === "off" ? "overlay" : prev), 100);
  };

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const compositeStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const camPreviewRef = useRef<HTMLVideoElement | null>(null);
  const pipWindowRef = useRef<Window | null>(null);

  // Live-updating bubble position ref (for the canvas draw loop)
  const bubblePosRef = useRef(bubblePos);
  const bubbleSizeRef = useRef(bubbleSize);
  useEffect(() => { bubblePosRef.current = bubblePos; }, [bubblePos]);
  useEffect(() => { bubbleSizeRef.current = bubbleSize; }, [bubbleSize]);

  // Bind processed camera stream to preview <video>
  useEffect(() => {
    if (camPreviewRef.current && camStream) {
      camPreviewRef.current.srcObject = camStream;
      camPreviewRef.current.play().catch(() => {});
    }
  }, [camStream]);

  useEffect(() => () => stopAll(), []);

  const stopAll = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    compositeStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
    micStreamRef.current = null;
    compositeStreamRef.current = null;
    closePip();
  };

  const pickMimeType = () => {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "video/webm";
  };

  const playVideo = (stream: MediaStream) => {
    const v = document.createElement("video");
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    return v.play().then(() => v).catch(() => v);
  };

  const openPip = async () => {
    if (!camStream) {
      toast.error("Enable the camera first");
      return;
    }
    // @ts-expect-error - documentPictureInPicture not in TS lib
    const dpip = window.documentPictureInPicture;
    if (dpip?.requestWindow) {
      try {
        const pipWin: Window = await dpip.requestWindow({ width: 320, height: 240 });
        pipWindowRef.current = pipWin;
        pipWin.document.body.style.margin = "0";
        pipWin.document.body.style.background = "#000";
        const v = pipWin.document.createElement("video");
        v.autoplay = true;
        v.muted = true;
        v.playsInline = true;
        v.style.width = "100%";
        v.style.height = "100%";
        v.style.objectFit = "cover";
        v.srcObject = camStream;
        pipWin.document.body.appendChild(v);
        pipWin.addEventListener("pagehide", () => {
          pipWindowRef.current = null;
          setPipActive(false);
        });
        setPipActive(true);
        return;
      } catch (e) {
        console.error(e);
      }
    }
    if (camPreviewRef.current && "requestPictureInPicture" in HTMLVideoElement.prototype) {
      try {
        await camPreviewRef.current.requestPictureInPicture();
        setPipActive(true);
        camPreviewRef.current.addEventListener("leavepictureinpicture", () => setPipActive(false), { once: true });
        return;
      } catch (e) {
        console.error(e);
      }
    }
    toast.error("Picture-in-Picture not supported in this browser");
  };

  const closePip = () => {
    try { pipWindowRef.current?.close(); } catch { /* noop */ }
    pipWindowRef.current = null;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
    setPipActive(false);
  };

  const startRecording = async () => {
    try {
      const { w, h } = RES_MAP[resolution];
      const frameRate = Number(fps);

      let displayStream: MediaStream | null = null;

      if (cameraMode !== "only") {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: w },
            height: { ideal: h },
            frameRate: { ideal: frameRate },
          },
          audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 48000 },
        });
        displayStreamRef.current = displayStream;
      }

      if (withMic) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
          });
          micStreamRef.current = mic;
        } catch {
          toast.error("Microphone access denied — recording without mic");
        }
      }

      let recordStream: MediaStream;

      if (cameraMode === "overlay" && displayStream && camStream) {
        const screenVideo = await playVideo(displayStream);
        const camVideo = await playVideo(camStream);

        const screenTrack = displayStream.getVideoTracks()[0];
        const settings = screenTrack.getSettings();
        const canvasW = settings.width || w;
        const canvasH = settings.height || h;

        const canvas = document.createElement("canvas");
        canvas.width = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext("2d")!;

        const draw = () => {
          ctx.drawImage(screenVideo, 0, 0, canvasW, canvasH);
          // Live bubble position from refs (updates in real time during recording)
          const bw = Math.round(canvasW * bubbleSizeRef.current);
          const bh = Math.round((bw * 9) / 16);
          const bx = Math.round(canvasW * bubblePosRef.current.x);
          const by = Math.round(canvasH * bubblePosRef.current.y);
          // shadow border
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(bx - 4, by - 4, bw + 8, bh + 8);
          ctx.drawImage(camVideo, bx, by, bw, bh);
          rafRef.current = requestAnimationFrame(draw);
        };
        draw();

        const canvasStream = canvas.captureStream(frameRate);
        const tracks: MediaStreamTrack[] = [canvasStream.getVideoTracks()[0]];
        displayStream.getAudioTracks().forEach((t) => tracks.push(t));
        micStreamRef.current?.getAudioTracks().forEach((t) => tracks.push(t));
        recordStream = new MediaStream(tracks);
        compositeStreamRef.current = recordStream;
      } else if (cameraMode === "only" && camStream) {
        const tracks: MediaStreamTrack[] = [...camStream.getVideoTracks()];
        micStreamRef.current?.getAudioTracks().forEach((t) => tracks.push(t));
        recordStream = new MediaStream(tracks);
      } else if (displayStream) {
        const tracks: MediaStreamTrack[] = [
          ...displayStream.getVideoTracks(),
          ...displayStream.getAudioTracks(),
        ];
        micStreamRef.current?.getAudioTracks().forEach((t) => tracks.push(t));
        recordStream = new MediaStream(tracks);
      } else {
        toast.error("No source selected");
        return;
      }

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(recordStream, {
        mimeType,
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 128_000,
      });

      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        setPreviewUrl(URL.createObjectURL(blob));
        stopAll();
      };

      const primaryVideo =
        displayStream?.getVideoTracks()[0] || camStream?.getVideoTracks()[0];
      primaryVideo?.addEventListener("ended", () => {
        if (recorder.state !== "inactive") recorder.stop();
        setRecording(false);
        if (timerRef.current) window.clearInterval(timerRef.current);
      });

      recorder.start(1000);
      recorderRef.current = recorder;
      setRecording(true);
      setElapsed(0);
      setPreviewUrl(null);
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
      toast.success("Recording started — drag the bubble to reposition live");
    } catch (err) {
      console.error(err);
      toast.error("Failed to start recording");
      stopAll();
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) window.clearInterval(timerRef.current);
    toast.success("Recording saved");
  };

  const download = () => {
    if (!previewUrl) return;
    const a = document.createElement("a");
    a.href = previewUrl;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `recording-${ts}.webm`;
    a.click();
  };

  const onBgImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setBgImageUrl(url);
    setBgMode("image");
  };

  const screenDisabled = cameraMode === "only";

  return (
    <div className="w-full max-w-3xl space-y-6">
      <Card className="p-8 shadow-[var(--shadow-card)] border-border/50 backdrop-blur">
        <div className="flex flex-col items-center gap-8">
          <div className="relative">
            <div
              className={`size-32 rounded-full flex items-center justify-center transition-all duration-500 ${
                recording
                  ? "bg-[image:var(--gradient-primary)] shadow-[var(--shadow-glow)] animate-pulse"
                  : "bg-secondary"
              }`}
            >
              {recording ? (
                <Square className="size-12 text-primary-foreground" fill="currentColor" />
              ) : (
                <Circle className="size-12 text-primary" fill="currentColor" />
              )}
            </div>
            {recording && (
              <div className="absolute inset-0 rounded-full border-2 border-primary/50 animate-ping" />
            )}
          </div>

          <div className="text-center">
            <div className="font-mono text-5xl tracking-wider tabular-nums">
              {formatTime(elapsed)}
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              {recording ? "Recording in progress…" : "Ready to record"}
            </p>
          </div>

          {!recording ? (
            <Button
              size="lg"
              onClick={startRecording}
              className="bg-[image:var(--gradient-primary)] hover:opacity-90 text-primary-foreground px-10 py-6 text-base font-semibold shadow-[var(--shadow-glow)] transition-all hover:scale-105"
            >
              <Video className="mr-2" /> Start Recording
            </Button>
          ) : (
            <Button
              size="lg"
              variant="destructive"
              onClick={stopRecording}
              className="px-10 py-6 text-base font-semibold"
            >
              <Square className="mr-2" fill="currentColor" /> Stop Recording
            </Button>
          )}
        </div>
      </Card>

      {/* Live camera preview & overlay positioner */}
      {cameraMode !== "off" && (
        <Card className="p-4 border-border/50 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Camera className="size-4" /> Live camera
            </h2>
            <Button size="sm" variant="secondary" onClick={pipActive ? closePip : openPip} className="gap-2">
              <PictureInPicture2 className="size-4" />
              {pipActive ? "Close pop-out" : "Pop out"}
            </Button>
          </div>

          <div className="relative rounded-md overflow-hidden bg-black aspect-video max-w-sm mx-auto">
            <video
              ref={camPreviewRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover"
            />
            {recording && (
              <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-primary/90 text-primary-foreground text-xs font-semibold">
                <span className="size-1.5 rounded-full bg-primary-foreground animate-pulse" /> REC
              </div>
            )}
          </div>

          {/* Background controls */}
          <div className="space-y-3 pt-2 border-t border-border/50">
            <Label className="flex items-center gap-2 text-sm">
              <Sparkles className="size-4" /> Background effect
            </Label>
            <Select value={bgMode} onValueChange={(v) => setBgMode(v as BackgroundMode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="blur">Blur background</SelectItem>
                <SelectItem value="image">Replace with image</SelectItem>
              </SelectContent>
            </Select>

            {bgMode === "blur" && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Blur amount: {blurAmount}px</Label>
                <Slider value={[blurAmount]} min={2} max={30} step={1} onValueChange={(v) => setBlurAmount(v[0])} />
              </div>
            )}

            {bgMode === "image" && (
              <div className="space-y-2">
                <Label htmlFor="bg-upload" className="flex items-center gap-2 text-xs cursor-pointer text-muted-foreground hover:text-foreground">
                  <ImageIcon className="size-4" /> Upload background image
                </Label>
                <input id="bg-upload" type="file" accept="image/*" onChange={onBgImageUpload} className="text-xs text-muted-foreground" />
                {bgImageUrl && (
                  <img src={bgImageUrl} alt="bg" className="w-16 h-10 object-cover rounded border border-border" />
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Background processing runs locally with on-device AI. First load may take a moment.
            </p>
          </div>

          {cameraMode === "overlay" && (
            <OverlayPositioner
              pos={bubblePos}
              size={bubbleSize}
              onPosChange={setBubblePos}
              onSizeChange={setBubbleSize}
              camStream={camStream}
            />
          )}
        </Card>
      )}

      <Card className="p-6 border-border/50">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Recording Settings
        </h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm">
              <Monitor className="size-4" /> Resolution
            </Label>
            <Select value={resolution} onValueChange={(v) => setResolution(v as Resolution)} disabled={recording || screenDisabled}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(RES_MAP).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm">
              <Video className="size-4" /> Frame Rate
            </Label>
            <Select value={fps} onValueChange={(v) => setFps(v as "30" | "60")} disabled={recording}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="60">60 FPS</SelectItem>
                <SelectItem value="30">30 FPS</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label className="flex items-center gap-2 text-sm">
              <Camera className="size-4" /> Camera
            </Label>
            <Select value={cameraMode} onValueChange={(v) => setCameraMode(v as CameraMode)} disabled={recording}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off — screen only</SelectItem>
                <SelectItem value="overlay">Overlay — camera bubble on screen</SelectItem>
                <SelectItem value="only">Camera only — no screen capture</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between p-3 rounded-md bg-secondary/50 sm:col-span-2">
            <Label htmlFor="mic" className="flex items-center gap-2 text-sm cursor-pointer">
              <Mic className="size-4" /> Include microphone audio
            </Label>
            <Switch id="mic" checked={withMic} onCheckedChange={setWithMic} disabled={recording} />
          </div>
        </div>
      </Card>

      {previewUrl && (
        <Card className="p-6 border-border/50 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Preview
            </h2>
            <Button onClick={download} variant="secondary">
              <Download className="mr-2 size-4" /> Download .webm
            </Button>
          </div>
          <video src={previewUrl} controls className="w-full rounded-md bg-black aspect-video" />
        </Card>
      )}
    </div>
  );
};

/**
 * Visual positioner: a 16:9 frame representing the screen, with a draggable
 * bubble showing where the camera will appear. Updates in real time —
 * during recording the canvas reads the same normalized position so you
 * can move the bubble live.
 */
const OverlayPositioner = ({
  pos,
  size,
  onPosChange,
  onSizeChange,
  camStream,
}: {
  pos: { x: number; y: number };
  size: number;
  onPosChange: (p: { x: number; y: number }) => void;
  onSizeChange: (s: number) => void;
  camStream: MediaStream | null;
}) => {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const bubbleVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (bubbleVideoRef.current && camStream) {
      bubbleVideoRef.current.srcObject = camStream;
      bubbleVideoRef.current.play().catch(() => {});
    }
  }, [camStream]);

  const handleMove = (clientX: number, clientY: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const bubbleW = rect.width * size;
    const bubbleH = bubbleW * 9 / 16;
    let x = (clientX - rect.left) / rect.width - size / 2;
    let y = (clientY - rect.top) / rect.height - (bubbleH / rect.height) / 2;
    x = Math.max(0, Math.min(1 - size, x));
    y = Math.max(0, Math.min(1 - bubbleH / rect.height, y));
    onPosChange({ x, y });
  };

  return (
    <div className="space-y-3 pt-2 border-t border-border/50">
      <Label className="text-sm">Bubble position {`(drag — works during recording too)`}</Label>
      <div
        ref={frameRef}
        className="relative w-full aspect-video rounded-md bg-secondary border border-dashed border-border overflow-hidden select-none"
        onPointerDown={(e) => {
          draggingRef.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          handleMove(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) handleMove(e.clientX, e.clientY);
        }}
        onPointerUp={() => { draggingRef.current = false; }}
      >
        <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-wider text-muted-foreground/60">
          Screen preview
        </div>
        <div
          className="absolute rounded-sm overflow-hidden ring-2 ring-primary shadow-lg pointer-events-none"
          style={{
            left: `${pos.x * 100}%`,
            top: `${pos.y * 100}%`,
            width: `${size * 100}%`,
            aspectRatio: "16 / 9",
          }}
        >
          {camStream ? (
            <video ref={bubbleVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-primary/30" />
          )}
        </div>
      </div>
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Bubble size: {Math.round(size * 100)}% of screen width</Label>
        <Slider value={[size * 100]} min={10} max={40} step={1} onValueChange={(v) => onSizeChange(v[0] / 100)} />
      </div>
    </div>
  );
};
