import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
} from "lucide-react";
import { useCameraStream } from "@/hooks/useCameraStream";

const formatTime = (s: number) => {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
};

type Props = {
  /** Show camera bubble on screen for the shared tab */
  showCamera: boolean;
  onToggleCamera: () => void;
};

/**
 * Floating recorder toolbar + draggable camera bubble for the Lecturer workspace.
 * The bubble is a real DOM element on this tab — when the lecturer shares this
 * tab via "Share tab" in the screen-share picker, the bubble is captured in
 * the recording, and they can drag it around live.
 */
export const LectureRecorderBar = ({ showCamera, onToggleCamera }: Props) => {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [withMic, setWithMic] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  const { rawStream, processedStream, error: camError, requestCamera, stopCamera } = useCameraStream({
    backgroundMode: "none",
  });
  const camStream = processedStream ?? rawStream;
  const camPreviewRef = useRef<HTMLVideoElement | null>(null);

  // Camera lifecycle tied to showCamera
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
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
    micStreamRef.current = null;
  };

  const pickMimeType = () => {
    const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "video/webm";
  };

  const start = async () => {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
        audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 48000 },
      });
      displayStreamRef.current = display;

      if (withMic) {
        try {
          micStreamRef.current = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
        } catch {
          toast.error("Microphone denied — recording without mic");
        }
      }

      const tracks: MediaStreamTrack[] = [
        ...display.getVideoTracks(),
        ...display.getAudioTracks(),
      ];
      micStreamRef.current?.getAudioTracks().forEach((t) => tracks.push(t));
      const stream = new MediaStream(tracks);

      const recorder = new MediaRecorder(stream, {
        mimeType: pickMimeType(),
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 128_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        setPreviewUrl(URL.createObjectURL(blob));
        cleanup();
      };
      display.getVideoTracks()[0].addEventListener("ended", () => {
        if (recorder.state !== "inactive") recorder.stop();
        setRecording(false);
        setPaused(false);
        if (timerRef.current) window.clearInterval(timerRef.current);
      });

      recorder.start(1000);
      recorderRef.current = recorder;
      setRecording(true);
      setPaused(false);
      setElapsed(0);
      setPreviewUrl(null);
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
      toast.success("Recording started — share this tab in the picker");
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

  const download = () => {
    if (!previewUrl) return;
    const a = document.createElement("a");
    a.href = previewUrl;
    a.download = `lecture-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
    a.click();
  };

  return (
    <>
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40">
        <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-card/95 backdrop-blur border border-border shadow-xl">
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

          {previewUrl && !recording && (
            <>
              <div className="w-px h-6 bg-border mx-1" />
              <Button size="sm" variant="secondary" onClick={download} className="gap-2">
                <Download className="size-4" /> Download
              </Button>
            </>
          )}
        </div>
      </div>

      {showCamera && (
        <DraggableCameraBubble
          videoRef={camPreviewRef}
          hasStream={!!camStream}
          recording={recording}
        />
      )}
    </>
  );
};

/** Floating, draggable, resizable camera bubble — captured when the tab is shared. */
const DraggableCameraBubble = ({
  videoRef,
  hasStream,
  recording,
}: {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  hasStream: boolean;
  recording: boolean;
}) => {
  const [pos, setPos] = useState(() => ({
    x: window.innerWidth - 280,
    y: window.innerHeight - 240,
  }));
  const [width, setWidth] = useState(240);
  const draggingRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizingRef = useRef<{ startX: number; startW: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (resizingRef.current) {
      const r = resizingRef.current;
      const next = Math.max(140, Math.min(520, r.startW + (e.clientX - r.startX)));
      setWidth(next);
      return;
    }
    if (!draggingRef.current) return;
    const d = draggingRef.current;
    const h = (width * 9) / 16;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - width, e.clientX - d.dx)),
      y: Math.max(0, Math.min(window.innerHeight - h, e.clientY - d.dy)),
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

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="fixed z-50 rounded-xl overflow-hidden shadow-2xl ring-2 ring-primary cursor-grab active:cursor-grabbing select-none"
      style={{ left: pos.x, top: pos.y, width, aspectRatio: "16 / 9" }}
    >
      {hasStream ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover bg-black pointer-events-none"
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
};
