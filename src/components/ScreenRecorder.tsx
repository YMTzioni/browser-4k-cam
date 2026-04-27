import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Circle, Square, Download, Monitor, Mic, Video, Camera } from "lucide-react";

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
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const compositeStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopAll = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    compositeStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
    camStreamRef.current = null;
    micStreamRef.current = null;
    compositeStreamRef.current = null;
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

  const startRecording = async () => {
    try {
      const { w, h } = RES_MAP[resolution];
      const frameRate = Number(fps);

      // Acquire streams
      let displayStream: MediaStream | null = null;
      let camStream: MediaStream | null = null;

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

      if (cameraMode !== "off") {
        try {
          camStream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: cameraMode === "only" ? w : 1280 },
              height: { ideal: cameraMode === "only" ? h : 720 },
              frameRate: { ideal: frameRate },
            },
          });
          camStreamRef.current = camStream;
        } catch {
          toast.error("Camera access denied");
          stopAll();
          return;
        }
      }

      // Mic
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

      // Build the recording stream
      let recordStream: MediaStream;

      if (cameraMode === "overlay" && displayStream && camStream) {
        // Composite screen + camera PiP onto a canvas
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
          // Camera PiP — bottom-right, ~22% width, 16:9
          const camW = Math.round(canvasW * 0.22);
          const camH = Math.round(camW * 9 / 16);
          const margin = Math.round(canvasW * 0.015);
          const x = canvasW - camW - margin;
          const y = canvasH - camH - margin;
          // Border
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(x - 4, y - 4, camW + 8, camH + 8);
          ctx.drawImage(camVideo, x, y, camW, camH);
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

      // Auto-stop if user cancels via browser UI
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
      toast.success("Recording started");
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
