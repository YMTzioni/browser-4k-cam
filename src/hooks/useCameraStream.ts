import { useCallback, useEffect, useRef, useState } from "react";
import { SelfieSegmentation, Results } from "@mediapipe/selfie_segmentation";

export type BackgroundMode = "none" | "blur" | "image";

interface Options {
  enabled: boolean;
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
  enabled,
  backgroundMode,
  backgroundImageUrl,
  blurAmount = 12,
}: Options) => {
  const [rawStream, setRawStream] = useState<MediaStream | null>(null);
  const [processedStream, setProcessedStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const segmenterRef = useRef<SelfieSegmentation | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
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
    if (rawStream) {
      rawStream.getTracks().forEach((t) => t.stop());
    }
    if (processedStream) {
      processedStream.getTracks().forEach((t) => t.stop());
    }
    setRawStream(null);
    setProcessedStream(null);
  }, [rawStream, processedStream]);

  // Start / stop based on enabled
  useEffect(() => {
    if (!enabled) {
      stopAll();
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        // Proactively check permission state when supported
        try {
          // @ts-expect-error - "camera" not in PermissionName typings everywhere
          const status = await navigator.permissions?.query({ name: "camera" });
          if (status?.state === "denied") {
            setError(
              "Camera blocked. Click the camera icon in your browser's address bar and allow access, then try again."
            );
            return;
          }
        } catch {
          /* permissions API unavailable — continue */
        }

        if (!navigator.mediaDevices?.getUserMedia) {
          setError("Camera API unavailable. Use a modern browser over HTTPS.");
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setRawStream(stream);

        // Set up offscreen video + canvas
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        videoElRef.current = video;

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        canvasRef.current = canvas;
        const ctx = canvas.getContext("2d")!;

        const segmenter = new SelfieSegmentation({
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
        setProcessedStream(out);
      } catch (e) {
        console.error(e);
        setError("Camera access denied");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => () => stopAll(), [stopAll]);

  return { rawStream, processedStream, canvasRef, error };
};
