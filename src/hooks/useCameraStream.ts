import { useCallback, useEffect, useRef, useState } from "react";
import type { Results, SelfieSegmentation as SelfieSegmentationType } from "@mediapipe/selfie_segmentation";

// MediaPipe ships a UMD bundle that attaches to `window` and doesn't expose
// a proper ES module export under Vite. Load it dynamically and pull the
// constructor off the module/global to avoid "SelfieSegmentation is not a constructor".
const loadSelfieSegmentation = async (): Promise<new (cfg: { locateFile: (f: string) => string }) => SelfieSegmentationType> => {
  const mod: Record<string, unknown> = await import("@mediapipe/selfie_segmentation");
  const w = window as unknown as Record<string, unknown>;
  const Ctor =
    (mod.SelfieSegmentation as unknown) ||
    ((mod.default as Record<string, unknown> | undefined)?.SelfieSegmentation as unknown) ||
    (w.SelfieSegmentation as unknown);
  if (typeof Ctor !== "function") {
    throw new Error("MediaPipe SelfieSegmentation failed to load.");
  }
  return Ctor as new (cfg: { locateFile: (f: string) => string }) => SelfieSegmentationType;
};

export type BackgroundMode = "none" | "blur" | "image";

interface Options {
  backgroundMode: BackgroundMode;
  backgroundImageUrl?: string | null;
  blurAmount?: number; // px
}

/**
 * Acquires the webcam and optionally applies background blur or replacement
 * via MediaPipe Selfie Segmentation. Returns BOTH the raw stream and a
 * processed stream (canvas-based) suitable for previewing and recording.
 */
export const useCameraStream = ({
  backgroundMode,
  backgroundImageUrl,
  blurAmount = 12,
}: Options) => {
  const [rawStream, setRawStream] = useState<MediaStream | null>(null);
  const [processedStream, setProcessedStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const segmenterRef = useRef<SelfieSegmentationType | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const rawStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const modeRef = useRef<BackgroundMode>(backgroundMode);
  const blurRef = useRef<number>(blurAmount);

  useEffect(() => {
    modeRef.current = backgroundMode;
  }, [backgroundMode]);
  useEffect(() => {
    blurRef.current = blurAmount;
  }, [blurAmount]);

  const getCameraErrorMessage = useCallback(async (e: unknown) => {
    const err = e as { name?: string; message?: string };

    if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") {
      return "No camera was detected on this device.";
    }

    if (err?.name === "NotReadableError") {
      return "Camera was found, but another app is using it. Close that app and try again.";
    }

    if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
      try {
        const status = await (navigator.permissions as Permissions | undefined)?.query({
          name: "camera" as PermissionName,
        });
        if (status?.state === "denied") {
          return "Camera permission is blocked. Allow camera access in your browser and try again.";
        }
      } catch {
        /* permissions API unavailable */
      }

      return "Camera access was denied. Click allow when your browser asks for permission.";
    }

    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.();
      const hasVideoInput = devices?.some((device) => device.kind === "videoinput");

      if (!hasVideoInput) {
        return "No camera was detected on this device.";
      }
    } catch {
      /* enumerateDevices unavailable */
    }

    return err?.message || "Camera could not be started.";
  }, []);

  // Load background image
  useEffect(() => {
    if (!backgroundImageUrl) {
      bgImageRef.current = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      bgImageRef.current = img;
    };
    img.src = backgroundImageUrl;
  }, [backgroundImageUrl]);

  const stopAll = useCallback(() => {
    runningRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (segmenterRef.current) {
      segmenterRef.current.close().catch(() => {});
      segmenterRef.current = null;
    }
    rawStreamRef.current?.getTracks().forEach((t) => t.stop());
    processedStreamRef.current?.getTracks().forEach((t) => t.stop());
    rawStreamRef.current = null;
    processedStreamRef.current = null;
    setRawStream(null);
    setProcessedStream(null);
  }, []);

  const requestCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera API unavailable. Use a modern browser over HTTPS.");
      return null;
    }

    if (rawStreamRef.current) {
      setError(null);
      return rawStreamRef.current;
    }

    try {
      setError(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });

      rawStreamRef.current = stream;
      setRawStream(stream);
      return stream;
    } catch (e: unknown) {
      console.error(e);
      setError(await getCameraErrorMessage(e));
      return null;
    }
  }, [getCameraErrorMessage]);

  useEffect(() => {
    if (!rawStream) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // Set up offscreen video + canvas
        const video = document.createElement("video");
        video.srcObject = rawStream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        videoElRef.current = video;

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        canvasRef.current = canvas;
        const ctx = canvas.getContext("2d")!;

        const SelfieSegmentationCtor = await loadSelfieSegmentation();
        if (cancelled) return;
        const segmenter = new SelfieSegmentationCtor({
          locateFile: (file) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
        });
        segmenter.setOptions({ modelSelection: 1 });
        segmenter.onResults((results: Results) => {
          const w = canvas.width;
          const h = canvas.height;
          const mode = modeRef.current;

          ctx.save();
          ctx.clearRect(0, 0, w, h);

          if (mode === "none") {
            ctx.drawImage(results.image, 0, 0, w, h);
            ctx.restore();
            return;
          }

          // Draw person mask
          ctx.drawImage(results.segmentationMask, 0, 0, w, h);
          // Keep only the person
          ctx.globalCompositeOperation = "source-in";
          ctx.drawImage(results.image, 0, 0, w, h);

          // Draw background behind
          ctx.globalCompositeOperation = "destination-over";
          if (mode === "blur") {
            ctx.filter = `blur(${blurRef.current}px)`;
            ctx.drawImage(results.image, 0, 0, w, h);
            ctx.filter = "none";
          } else if (mode === "image" && bgImageRef.current) {
            // cover-fit
            const img = bgImageRef.current;
            const cr = w / h;
            const ir = img.width / img.height;
            let dw = w, dh = h, dx = 0, dy = 0;
            if (ir > cr) {
              dh = h;
              dw = h * ir;
              dx = (w - dw) / 2;
            } else {
              dw = w;
              dh = w / ir;
              dy = (h - dh) / 2;
            }
            ctx.drawImage(img, dx, dy, dw, dh);
          } else {
            // fallback solid
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, w, h);
          }
          ctx.restore();
        });
        segmenterRef.current = segmenter;

        // Processing loop — always runs so canvas mirrors raw video even in "none" mode
        runningRef.current = true;
        const tick = async () => {
          if (!runningRef.current) return;
          if (video.readyState >= 2) {
            if (modeRef.current === "none") {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            } else {
              try {
                await segmenter.send({ image: video });
              } catch {
                /* ignore */
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();

        // captureStream from canvas — will be used for preview & recording
        const out = canvas.captureStream(30);
        processedStreamRef.current = out;
        setProcessedStream(out);
      } catch (e: unknown) {
        console.error(e);
        setError(await getCameraErrorMessage(e));
      }
    })();

    return () => {
      cancelled = true;
      runningRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      processedStreamRef.current?.getTracks().forEach((track) => track.stop());
      processedStreamRef.current = null;
      setProcessedStream(null);
    };
  }, [getCameraErrorMessage, rawStream]);

  useEffect(() => () => stopAll(), [stopAll]);

  return { rawStream, processedStream, canvasRef, error, requestCamera, stopCamera: stopAll };
};
