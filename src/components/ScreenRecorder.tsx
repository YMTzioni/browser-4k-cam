import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Circle, Square, Download, Monitor, Mic, Video } from "lucide-react";

type Resolution = "2160" | "1440" | "1080" | "720";

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
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopAll = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    micStreamRef.current = null;
  };

  const pickMimeType = () => {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "video/webm";
  };

  const startRecording = async () => {
    try {
      const { w, h } = RES_MAP[resolution];
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: w },
          height: { ideal: h },
          frameRate: { ideal: Number(fps) },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 48000,
        },
      });

      let combined = displayStream;
      if (withMic) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
          });
          micStreamRef.current = mic;
          const tracks = [
            ...displayStream.getVideoTracks(),
            ...displayStream.getAudioTracks(),
            ...mic.getAudioTracks(),
          ];
          combined = new MediaStream(tracks);
        } catch {
          toast.error("Microphone access denied — recording without mic");
        }
      }

      streamRef.current = combined;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(combined, {
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
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        stopAll();
      };

      // Stop if user cancels via browser UI
      displayStream.getVideoTracks()[0].addEventListener("ended", () => {
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

  return (
    <div className="w-full max-w-3xl space-y-6">
      <Card className="p-8 shadow-[var(--shadow-card)] border-border/50 backdrop-blur">
        <div className="flex flex-col items-center gap-8">
          {/* Status orb */}
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

          {/* Timer */}
          <div className="text-center">
            <div className="font-mono text-5xl tracking-wider tabular-nums">
              {formatTime(elapsed)}
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              {recording ? "Recording in progress…" : "Ready to record"}
            </p>
          </div>

          {/* Action button */}
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

      {/* Settings */}
      <Card className="p-6 border-border/50">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Recording Settings
        </h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm">
              <Monitor className="size-4" /> Resolution
            </Label>
            <Select value={resolution} onValueChange={(v) => setResolution(v as Resolution)} disabled={recording}>
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

          <div className="flex items-center justify-between p-3 rounded-md bg-secondary/50 sm:col-span-2">
            <Label htmlFor="mic" className="flex items-center gap-2 text-sm cursor-pointer">
              <Mic className="size-4" /> Include microphone audio
            </Label>
            <Switch id="mic" checked={withMic} onCheckedChange={setWithMic} disabled={recording} />
          </div>
        </div>
      </Card>

      {/* Preview */}
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
