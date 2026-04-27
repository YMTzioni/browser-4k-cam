import { useCallback, useEffect, useRef, useState } from "react";

export type AnnotationTool =
  | "pen"
  | "highlighter"
  | "eraser"
  | "laser"
  | "arrow"
  | "rect"
  | "ellipse"
  | "line"
  | "text";

export type Stroke = {
  id: number;
  tool: AnnotationTool;
  color: string;
  size: number;
  points: { x: number; y: number }[];
  text?: string;
  // For laser strokes — wall-clock ms when drawn (for fade)
  createdAt?: number;
};

const LASER_FADE_MS = 1500;

export function useAnnotationCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const idRef = useRef(1);
  const [, setTick] = useState(0);
  const tick = () => setTick((n) => n + 1);

  const resize = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(rect.width * dpr));
    c.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = c.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  const drawStroke = (ctx: CanvasRenderingContext2D, s: Stroke, alpha = 1) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size;

    if (s.tool === "highlighter") {
      ctx.globalAlpha = alpha * 0.35;
      ctx.lineWidth = s.size * 3;
    }
    if (s.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = s.size * 2.5;
      ctx.strokeStyle = "rgba(0,0,0,1)";
    }

    const pts = s.points;
    if (pts.length === 0) {
      ctx.restore();
      return;
    }

    if (s.tool === "rect" && pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else if (s.tool === "ellipse" && pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      ctx.beginPath();
      ctx.ellipse(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        Math.abs(b.x - a.x) / 2,
        Math.abs(b.y - a.y) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } else if (s.tool === "line" && pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else if (s.tool === "arrow" && pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(10, s.size * 4);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else if (s.tool === "text" && s.text) {
      ctx.font = `${Math.max(14, s.size * 6)}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(s.text, pts[0].x, pts[0].y);
    } else if (s.tool === "laser") {
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 16;
      ctx.lineWidth = Math.max(3, s.size);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    } else {
      // pen / highlighter / eraser freehand
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  };

  const render = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const rect = c.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    const now = performance.now();
    // Drop expired laser strokes
    strokesRef.current = strokesRef.current.filter(
      (s) => s.tool !== "laser" || now - (s.createdAt ?? 0) < LASER_FADE_MS,
    );

    for (const s of strokesRef.current) {
      let alpha = 1;
      if (s.tool === "laser") {
        const age = now - (s.createdAt ?? 0);
        alpha = Math.max(0, 1 - age / LASER_FADE_MS);
      }
      drawStroke(ctx, s, alpha);
    }
    if (drawingRef.current) drawStroke(ctx, drawingRef.current);
  }, []);

  // Continuous render loop (cheap; needed for laser fade)
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [render]);

  const beginStroke = (tool: AnnotationTool, color: string, size: number, x: number, y: number, text?: string) => {
    const stroke: Stroke = {
      id: idRef.current++,
      tool,
      color,
      size,
      points: [{ x, y }],
      text,
      createdAt: tool === "laser" ? performance.now() : undefined,
    };
    if (tool === "text") {
      strokesRef.current.push(stroke);
      redoRef.current = [];
      tick();
      return;
    }
    drawingRef.current = stroke;
  };

  const extendStroke = (x: number, y: number) => {
    if (!drawingRef.current) return;
    drawingRef.current.points.push({ x, y });
  };

  const endStroke = () => {
    if (!drawingRef.current) return;
    strokesRef.current.push(drawingRef.current);
    drawingRef.current = null;
    redoRef.current = [];
    tick();
  };

  const undo = () => {
    const s = strokesRef.current.pop();
    if (s) {
      redoRef.current.push(s);
      tick();
    }
  };
  const redo = () => {
    const s = redoRef.current.pop();
    if (s) {
      strokesRef.current.push(s);
      tick();
    }
  };
  const clear = () => {
    strokesRef.current = [];
    redoRef.current = [];
    drawingRef.current = null;
    tick();
  };

  return {
    canvasRef,
    beginStroke,
    extendStroke,
    endStroke,
    undo,
    redo,
    clear,
    resize,
  };
}
