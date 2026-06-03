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
  /** When set, only this camera is used ({ exact: deviceId }). */
  deviceId?: string | null;
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

/** Cap processing resolution so ML + canvas capture stay real-time on long sessions. */
const fitCanvasToVideo = (canvas: HTMLCanvasElement, video: HTMLVideoElement, maxWidth: number) => {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const scale = Math.min(1, maxWidth / vw);
  const w = Math.max(2, Math.round((vw * scale) / 2) * 2);
  const h = Math.max(2, Math.round((vh * scale) / 2) * 2);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
};

type CropRect = { sx: number; sy: number; cropW: number; cropH: number };

const paintCutoutFrame = (
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  maskCanvas: HTMLCanvasElement,
  crop: CropRect,
  outW: number,
  outH: number,
) => {
  const { sx, sy, cropW, cropH } = crop;
  ctx.save();
  ctx.clearRect(0, 0, outW, outH);
  ctx.drawImage(maskCanvas, 0, 0, outW, outH);
  ctx.globalCompositeOperation = "source-in";
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, outW, outH);
  ctx.restore();
};

const paintBlurFrame = (
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  maskCanvas: HTMLCanvasElement,
  crop: CropRect,
  blurPx: number,
  outW: number,
  outH: number,
) => {
  const { sx, sy, cropW, cropH } = crop;
  ctx.save();
  ctx.clearRect(0, 0, outW, outH);
  ctx.drawImage(maskCanvas, 0, 0, outW, outH);
  ctx.globalCompositeOperation = "source-in";
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, outW, outH);
  ctx.globalCompositeOperation = "destination-over";
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, outW, outH);
  ctx.filter = "none";
  ctx.restore();
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
  deviceId = null,
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
  const deviceIdRef = useRef<string | null>(deviceId);
  const openingRef = useRef<Promise<MediaStream | null> | null>(null);

  useEffect(() => {
    modeRef.current = backgroundMode;
  }, [backgroundMode]);
  useEffect(() => {
    blurRef.current = blurAmount;
  }, [blurAmount]);
  useEffect(() => {
    autoCenterRef.current = autoCenter;
  }, [autoCenter]);
  useEffect(() => {
    deviceIdRef.current = deviceId;
  }, [deviceId]);

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

    if (openingRef.current) {
      return openingRef.current;
    }

    openingRef.current = (async () => {
      try {
        setError(null);

        const wantedId = deviceIdRef.current ?? undefined;
        const existing = rawStreamRef.current;
        if (existing) {
          const activeId = existing.getVideoTracks()[0]?.getSettings().deviceId;
          if (!wantedId || activeId === wantedId) {
            return existing;
          }
          existing.getVideoTracks().forEach((track) => track.stop());
          rawStreamRef.current = null;
          setRawStream(null);
        }

        const video: MediaTrackConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        };
        if (wantedId) {
          video.deviceId = { exact: wantedId };
        }

        const stream = await navigator.mediaDevices.getUserMedia({ video });

        rawStreamRef.current = stream;
        setRawStream(stream);
        return stream;
      } catch (e: unknown) {
        console.error(e);
        setError(await getCameraErrorMessage(e));
        return null;
      } finally {
        openingRef.current = null;
      }
    })();

    return openingRef.current;
  }, [getCameraErrorMessage]);

  useEffect(() => {
    if (!deviceId || !rawStreamRef.current) return;
    const activeId = rawStreamRef.current.getVideoTracks()[0]?.getSettings().deviceId;
    if (activeId && activeId !== deviceId) {
      void requestCamera();
    }
  }, [deviceId, requestCamera]);

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
        const maxProcessWidth = backgroundMode === "cutout" ? 640 : 960;
        fitCanvasToVideo(canvas, video, maxProcessWidth);
        canvasRef.current = canvas;
        const ctx = canvas.getContext("2d")!;

        // Keep in line with lecture composer (24fps) to reduce duplicate work and heat.
        const CAPTURE_FPS = 24;
        const srcW = () => video.videoWidth || canvas.width;
        const srcH = () => video.videoHeight || canvas.height;

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
          let mlInFlight = false;
          let lastMlAt = 0;
          const FACE_ML_FPS = 8;
          const faceMlInterval = 1000 / FACE_ML_FPS;

          cancelVideoPump = subscribeVideoPump(
            video,
            () => {
              if (video.readyState < 2) return;
              const w = canvas.width;
              const h = canvas.height;
              const sw = srcW();
              const sh = srcH();
              const { sx, sy, cropW, cropH } = updateCenterAndCrop(
                center,
                faceBoxRef.current,
                autoCenterRef.current,
                sw,
                sh,
              );
              ctx.clearRect(0, 0, w, h);
              ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, w, h);

              const now = performance.now();
              if (mlInFlight || now - lastMlAt < faceMlInterval) return;
              lastMlAt = now;
              mlInFlight = true;
              void faceDetector
                .send({ image: video })
                .catch(() => {})
                .finally(() => {
                  mlInFlight = false;
                });
            },
            () => runningRef.current && !cancelled,
          );

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
        // Model 0 is faster; sufficient for lecturer cutout in a small bubble.
        segmenter.setOptions({ modelSelection: backgroundMode === "cutout" ? 0 : 1 });

        const center = { x: 0.5, y: 0.5, scale: 1 };
        const faceBoxRef: { current: FaceBox | null } = { current: null };
        const maskCanvas = document.createElement("canvas");
        const maskCtx = maskCanvas.getContext("2d")!;
        let hasMask = false;

        const useFaceForCenter =
          autoCenterRef.current && backgroundMode !== "cutout";
        let faceDetector: FaceDetectionType | null = null;
        if (useFaceForCenter) {
          const FaceDetectionCtor = await loadFaceDetection();
          if (cancelled) return;
          faceDetector = new FaceDetectionCtor({
            locateFile: (file) =>
              `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`,
          });
          faceDetector.setOptions({ model: "short", minDetectionConfidence: 0.5 });
          faceDetectorRef.current = faceDetector;
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
        }

        segmenter.onResults((results: Results) => {
          const w = canvas.width;
          const h = canvas.height;
          if (maskCanvas.width !== w || maskCanvas.height !== h) {
            maskCanvas.width = w;
            maskCanvas.height = h;
          }
          const sw = srcW();
          const sh = srcH();
          const { sx, sy, cropW, cropH } = updateCenterAndCrop(
            center,
            faceBoxRef.current,
            useFaceForCenter,
            sw,
            sh,
          );
          maskCtx.clearRect(0, 0, w, h);
          maskCtx.drawImage(results.segmentationMask, sx, sy, cropW, cropH, 0, 0, w, h);
          hasMask = true;
        });
        segmenterRef.current = segmenter;

        runningRef.current = true;
        let mlInFlight = false;
        let lastMlAt = 0;
        const SEGMENT_ML_FPS = backgroundMode === "cutout" ? 12 : 10;
        const segmentMlInterval = 1000 / SEGMENT_ML_FPS;
        let lastFaceMlAt = 0;
        const FACE_ML_FPS = 6;

        const paintSegmentedFrame = () => {
          if (video.readyState < 2) return;
          const w = canvas.width;
          const h = canvas.height;
          const sw = srcW();
          const sh = srcH();
          const crop = updateCenterAndCrop(center, faceBoxRef.current, useFaceForCenter, sw, sh);
          const mode = modeRef.current;

          if (mode === "cutout") {
            if (!hasMask) return;
            paintCutoutFrame(ctx, video, maskCanvas, crop, w, h);
            return;
          }

          if (mode === "blur") {
            if (!hasMask) return;
            paintBlurFrame(ctx, video, maskCanvas, crop, blurRef.current, w, h);
            return;
          }

          if (mode === "image" && bgImageRef.current) {
            if (!hasMask) return;
            const { sx, sy, cropW, cropH } = crop;
            ctx.save();
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(maskCanvas, 0, 0, w, h);
            ctx.globalCompositeOperation = "source-in";
            ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, w, h);
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
            ctx.restore();
            return;
          }

          const { sx, sy, cropW, cropH } = crop;
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, w, h);
        };

        cancelVideoPump = subscribeVideoPump(
          video,
          () => {
            paintSegmentedFrame();
            const now = performance.now();
            if (mlInFlight || now - lastMlAt < segmentMlInterval) return;
            lastMlAt = now;
            mlInFlight = true;
            void segmenter
              .send({ image: video })
              .catch(() => {})
              .finally(() => {
                mlInFlight = false;
              });

            if (faceDetector && useFaceForCenter && now - lastFaceMlAt >= 1000 / FACE_ML_FPS) {
              lastFaceMlAt = now;
              void faceDetector.send({ image: video }).catch(() => {});
            }
          },
          () => runningRef.current && !cancelled,
        );

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
