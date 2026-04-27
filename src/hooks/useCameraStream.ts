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

        // Auto-center state — smoothed person bbox center (in 0..1 of source).
        // We compute the centroid of the segmentation mask each frame and
        // ease the crop window toward it so the person stays centered.
        const center = { x: 0.5, y: 0.5, scale: 1 };
        const maskAnalyzer = document.createElement("canvas");
        maskAnalyzer.width = 64;
        maskAnalyzer.height = 36;
        const mctx = maskAnalyzer.getContext("2d", { willReadFrequently: true })!;

        const computePersonBox = (mask: CanvasImageSource) => {
          mctx.clearRect(0, 0, maskAnalyzer.width, maskAnalyzer.height);
          mctx.drawImage(mask, 0, 0, maskAnalyzer.width, maskAnalyzer.height);
          const { data } = mctx.getImageData(0, 0, maskAnalyzer.width, maskAnalyzer.height);
          let sumX = 0, sumY = 0, count = 0;
          let minX = maskAnalyzer.width, maxX = 0, minY = maskAnalyzer.height, maxY = 0;
          for (let y = 0; y < maskAnalyzer.height; y++) {
            for (let x = 0; x < maskAnalyzer.width; x++) {
              const i = (y * maskAnalyzer.width + x) * 4;
              // MediaPipe mask: high alpha or high red = person.
              const v = data[i] || data[i + 3];
              if (v > 128) {
                sumX += x; sumY += y; count++;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
              }
            }
          }
          if (count < 50) return null;
          return {
            cx: sumX / count / maskAnalyzer.width,
            cy: sumY / count / maskAnalyzer.height,
            bw: (maxX - minX) / maskAnalyzer.width,
            bh: (maxY - minY) / maskAnalyzer.height,
          };
        };

        segmenter.onResults((results: Results) => {
          const w = canvas.width;
          const h = canvas.height;
          const mode = modeRef.current;

          // Compute person centroid + size and ease toward it.
          const box = computePersonBox(results.segmentationMask);
          if (box) {
            // Target scale: keep person occupying ~70% of the shorter axis.
            const personSize = Math.max(box.bw, box.bh);
            const targetScale = Math.min(2.2, Math.max(1, 0.7 / Math.max(0.05, personSize)));
            // Smooth (lerp)
            center.x += (box.cx - center.x) * 0.12;
            center.y += (box.cy - center.y) * 0.12;
            center.scale += (targetScale - center.scale) * 0.08;
          }

          // Crop window in source coords keeping person centered.
          const cropW = w / center.scale;
          const cropH = h / center.scale;
          let sx = center.x * w - cropW / 2;
          let sy = center.y * h - cropH / 2;
          sx = Math.max(0, Math.min(w - cropW, sx));
          sy = Math.max(0, Math.min(h - cropH, sy));

          ctx.save();
          ctx.clearRect(0, 0, w, h);

          if (mode === "none") {
            ctx.drawImage(results.image, sx, sy, cropW, cropH, 0, 0, w, h);
            ctx.restore();
            return;
          }

          // Person mask cropped & scaled to canvas
          ctx.drawImage(results.segmentationMask, sx, sy, cropW, cropH, 0, 0, w, h);
          ctx.globalCompositeOperation = "source-in";
          ctx.drawImage(results.image, sx, sy, cropW, cropH, 0, 0, w, h);

          ctx.globalCompositeOperation = "destination-over";
          if (mode === "blur") {
            ctx.filter = `blur(${blurRef.current}px)`;
            ctx.drawImage(results.image, sx, sy, cropW, cropH, 0, 0, w, h);
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
            // Always run segmentation so auto-centering works in every mode.
            try {
              await segmenter.send({ image: video });
            } catch {
              /* ignore */
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
