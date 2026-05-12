import { useCallback, useEffect, useRef, useState } from "react";
import type { Results, SelfieSegmentation as SelfieSegmentationType } from "@mediapipe/selfie_segmentation";
import type { FaceDetection as FaceDetectionType, Results as FaceResults } from "@mediapipe/face_detection";

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

const loadFaceDetection = async (): Promise<new (cfg: { locateFile: (f: string) => string }) => FaceDetectionType> => {
  const mod: Record<string, unknown> = await import("@mediapipe/face_detection");
  const w = window as unknown as Record<string, unknown>;
  const Ctor =
    (mod.FaceDetection as unknown) ||
    ((mod.default as Record<string, unknown> | undefined)?.FaceDetection as unknown) ||
    (w.FaceDetection as unknown);
  if (typeof Ctor !== "function") {
    throw new Error("MediaPipe FaceDetection failed to load.");
  }
  return Ctor as new (cfg: { locateFile: (f: string) => string }) => FaceDetectionType;
};

export type BackgroundMode = "none" | "blur" | "image" | "cutout";

interface Options {
  backgroundMode: BackgroundMode;
  backgroundImageUrl?: string | null;
  blurAmount?: number; // px
  autoCenter?: boolean;
}

type FaceBox = { cx: number; cy: number; bw: number; bh: number };

/**
 * Drive updates from actual decoded camera frames when possible (smoother than a
 * blind rAF loop). Falls back to rAF where requestVideoFrameCallback is missing.
 */
const subscribeVideoPump = (
  video: HTMLVideoElement,
  onFrame: () => void,
  isRunning: () => boolean,
): (() => void) => {
  if (typeof video.requestVideoFrameCallback === "function") {
    let handle = 0;
    const pump: VideoFrameCallback = () => {
      if (!isRunning()) return;
      onFrame();
      if (!isRunning()) return;
      handle = video.requestVideoFrameCallback(pump);
    };
    handle = video.requestVideoFrameCallback(pump);
    return () => {
      video.cancelVideoFrameCallback(handle);
    };
  }
  let rafId = 0;
  const pump = () => {
    if (!isRunning()) return;
    onFrame();
    if (!isRunning()) return;
    rafId = requestAnimationFrame(pump);
  };
  rafId = requestAnimationFrame(pump);
  return () => cancelAnimationFrame(rafId);
};

/**
 * Smooth zoom/pan state + crop rect in **source pixel** space (video frame size).
 */
const updateCenterAndCrop = (
  center: { x: number; y: number; scale: number },
  faceBox: FaceBox | null,
  autoCenter: boolean,
  w: number,
  h: number,
) => {
  // Product decision: keep lecturer at natural size (no digital zoom).
  // We may still gently track center metadata, but output scale stays fixed at 1.
  if (autoCenter && faceBox) {
    const targetY = faceBox.cy + faceBox.bh * 0.1;
    center.x += (faceBox.cx - center.x) * 0.22;
    center.y += (targetY - center.y) * 0.22;
    center.scale += (1 - center.scale) * 0.2;
  } else {
    center.x += (0.5 - center.x) * 0.2;
    center.y += (0.5 - center.y) * 0.2;
    center.scale += (1 - center.scale) * 0.2;
  }

  const cropW = w / center.scale;
  const cropH = h / center.scale;
  let sx = center.x * w - cropW / 2;
  let sy = center.y * h - cropH / 2;
  sx = Math.max(0, Math.min(w - cropW, sx));
  sy = Math.max(0, Math.min(h - cropH, sy));
  return { sx, sy, cropW, cropH };
};

/**
 * Acquires the webcam and optionally applies background blur or replacement
 * via MediaPipe Selfie Segmentation. Returns BOTH the raw stream and a
 * processed stream (canvas-based) suitable for previewing and recording.
 *
 * Latency note: running selfie segmentation on every frame adds noticeable
 * delay between mic and picture. When `backgroundMode === "none"` we avoid
 * segmentation entirely — raw frames for no auto-center, face-detection-only
 * cropping when auto-center is on.
 */
export const useCameraStream = ({
  backgroundMode,
  backgroundImageUrl,
  blurAmount = 12,
  autoCenter = false,
}: Options) => {
  const [rawStream, setRawStream] = useState<MediaStream | null>(null);
  const [processedStream, setProcessedStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const segmenterRef = useRef<SelfieSegmentationType | null>(null);
  const faceDetectorRef = useRef<FaceDetectionType | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const rawStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const modeRef = useRef<BackgroundMode>(backgroundMode);
  const blurRef = useRef<number>(blurAmount);
  const autoCenterRef = useRef<boolean>(autoCenter);

  useEffect(() => {
    modeRef.current = backgroundMode;
  }, [backgroundMode]);
  useEffect(() => {
    blurRef.current = blurAmount;
  }, [blurAmount]);
  useEffect(() => {
    autoCenterRef.current = autoCenter;
  }, [autoCenter]);

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
    if (faceDetectorRef.current) {
      faceDetectorRef.current.close().catch(() => {});
      faceDetectorRef.current = null;
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
    let cancelVideoPump: (() => void) | null = null;

    const closeMl = () => {
      if (segmenterRef.current) {
        segmenterRef.current.close().catch(() => {});
        segmenterRef.current = null;
      }
      if (faceDetectorRef.current) {
        faceDetectorRef.current.close().catch(() => {});
        faceDetectorRef.current = null;
      }
    };

    (async () => {
      try {
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

        // Keep in line with lecture composer (24fps) to reduce duplicate work and heat.
        const CAPTURE_FPS = 24;

        // --- Fast path: no ML — lowest latency (mic vs camera sync). ---
        if (backgroundMode === "none" && !autoCenter) {
          closeMl();
          runningRef.current = true;
          cancelVideoPump = subscribeVideoPump(
            video,
            () => {
              if (video.readyState >= 2) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              }
            },
            () => runningRef.current && !cancelled,
          );
          const out = canvas.captureStream(CAPTURE_FPS);
          processedStreamRef.current = out;
          setProcessedStream(out);
          return;
        }

        // --- Face-only path (none + auto-center): detection only, no segmentation. ---
        if (backgroundMode === "none" && autoCenter) {
          closeMl();
          const FaceDetectionCtor = await loadFaceDetection();
          if (cancelled) return;

          const faceDetector = new FaceDetectionCtor({
            locateFile: (file) =>
              `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`,
          });
          faceDetector.setOptions({ model: "short", minDetectionConfidence: 0.5 });
          faceDetectorRef.current = faceDetector;

          const faceBoxRef: { current: FaceBox | null } = { current: null };
          faceDetector.onResults((results: FaceResults) => {
            const det = results.detections?.[0];
            if (!det) {
              faceBoxRef.current = null;
              return;
            }
            const bb = det.boundingBox as unknown as {
              xCenter: number;
              yCenter: number;
              width: number;
              height: number;
            };
            faceBoxRef.current = {
              cx: bb.xCenter,
              cy: bb.yCenter,
              bw: bb.width,
              bh: bb.height,
            };
          });

          const center = { x: 0.5, y: 0.5, scale: 1 };
          runningRef.current = true;
          let frame = 0;
          const tick = async () => {
            if (!runningRef.current || cancelled) return;
            if (video.readyState >= 2) {
              const w = canvas.width;
              const h = canvas.height;
              if (frame++ % 2 === 0) {
                try {
                  await faceDetector.send({ image: video });
                } catch {
                  /* ignore */
                }
              }
              const { sx, sy, cropW, cropH } = updateCenterAndCrop(center, faceBoxRef.current, autoCenterRef.current, w, h);
              ctx.clearRect(0, 0, w, h);
              ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, w, h);
            }
            rafRef.current = requestAnimationFrame(() => {
              void tick();
            });
          };
          tick();

          const out = canvas.captureStream(CAPTURE_FPS);
          processedStreamRef.current = out;
          setProcessedStream(out);
          return;
        }

        // --- Full segmentation path (blur / image): heavier, higher latency. ---
        const SelfieSegmentationCtor = await loadSelfieSegmentation();
        if (cancelled) return;
        const segmenter = new SelfieSegmentationCtor({
          locateFile: (file) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
        });
        segmenter.setOptions({ modelSelection: 1 });

        const FaceDetectionCtor = await loadFaceDetection();
        if (cancelled) return;
        const faceDetector = new FaceDetectionCtor({
          locateFile: (file) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`,
        });
        faceDetector.setOptions({ model: "short", minDetectionConfidence: 0.5 });
        faceDetectorRef.current = faceDetector;

        const center = { x: 0.5, y: 0.5, scale: 1 };
        const faceBoxRef: { current: FaceBox | null } = { current: null };

        faceDetector.onResults((results: FaceResults) => {
          const det = results.detections?.[0];
          if (!det) {
            faceBoxRef.current = null;
            return;
          }
          const bb = det.boundingBox as unknown as {
            xCenter: number;
            yCenter: number;
            width: number;
            height: number;
          };
          faceBoxRef.current = {
            cx: bb.xCenter,
            cy: bb.yCenter,
            bw: bb.width,
            bh: bb.height,
          };
        });

        segmenter.onResults((results: Results) => {
          const w = canvas.width;
          const h = canvas.height;
          const mode = modeRef.current;

          const { sx, sy, cropW, cropH } = updateCenterAndCrop(
            center,
            faceBoxRef.current,
            autoCenterRef.current,
            w,
            h,
          );

          ctx.save();
          ctx.clearRect(0, 0, w, h);

          if (mode === "cutout") {
            // Keep only the lecturer pixels and leave background transparent.
            ctx.drawImage(results.segmentationMask, sx, sy, cropW, cropH, 0, 0, w, h);
            ctx.globalCompositeOperation = "source-in";
            ctx.drawImage(results.image, sx, sy, cropW, cropH, 0, 0, w, h);
          } else if (mode === "blur") {
            ctx.drawImage(results.segmentationMask, sx, sy, cropW, cropH, 0, 0, w, h);
            ctx.globalCompositeOperation = "source-in";
            ctx.drawImage(results.image, sx, sy, cropW, cropH, 0, 0, w, h);

            ctx.globalCompositeOperation = "destination-over";
            ctx.filter = `blur(${blurRef.current}px)`;
            ctx.drawImage(results.image, sx, sy, cropW, cropH, 0, 0, w, h);
            ctx.filter = "none";
          } else if (mode === "image" && bgImageRef.current) {
            ctx.drawImage(results.segmentationMask, sx, sy, cropW, cropH, 0, 0, w, h);
            ctx.globalCompositeOperation = "source-in";
            ctx.drawImage(results.image, sx, sy, cropW, cropH, 0, 0, w, h);

            ctx.globalCompositeOperation = "destination-over";
            const img = bgImageRef.current;
            const cr = w / h;
            const ir = img.width / img.height;
            let dw = w,
              dh = h,
              dx = 0,
              dy = 0;
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
            ctx.drawImage(results.image, sx, sy, cropW, cropH, 0, 0, w, h);
          }
          ctx.restore();
        });
        segmenterRef.current = segmenter;

        runningRef.current = true;
        let faceFrame = 0;
        const tick = async () => {
          if (!runningRef.current || cancelled) return;
          if (video.readyState >= 2) {
            try {
              await segmenter.send({ image: video });
            } catch {
              /* ignore */
            }
            if (autoCenterRef.current && faceFrame++ % 2 === 0) {
              try {
                await faceDetector.send({ image: video });
              } catch {
                /* ignore */
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();

        const out = canvas.captureStream(CAPTURE_FPS);
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
      cancelVideoPump?.();
      cancelVideoPump = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (segmenterRef.current) {
        segmenterRef.current.close().catch(() => {});
        segmenterRef.current = null;
      }
      if (faceDetectorRef.current) {
        faceDetectorRef.current.close().catch(() => {});
        faceDetectorRef.current = null;
      }
      processedStreamRef.current?.getTracks().forEach((track) => track.stop());
      processedStreamRef.current = null;
      setProcessedStream(null);
    };
  }, [getCameraErrorMessage, rawStream, backgroundMode, autoCenter]);

  useEffect(() => () => stopAll(), [stopAll]);

  return { rawStream, processedStream, canvasRef, error, requestCamera, stopCamera: stopAll };
};
