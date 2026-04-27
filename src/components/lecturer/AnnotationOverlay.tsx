import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { Button } from "@/components/ui/button";
import {
  Pen,
  Highlighter,
  Eraser,
  Pointer,
  ArrowUpRight,
  Square as SquareIcon,
  Circle as CircleIcon,
  Minus,
  Type,
  Undo2,
  Redo2,
  Trash2,
  X,
  Keyboard,
} from "lucide-react";
import { useAnnotationCanvas, AnnotationTool } from "@/hooks/useAnnotationCanvas";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export type AnnotationOverlayHandle = {
  /** The HTMLCanvasElement so it can be composited into the recording. */
  getCanvas: () => HTMLCanvasElement | null;
};

const COLORS = ["#ef4444", "#f59e0b", "#eab308", "#22c55e", "#3b82f6", "#a855f7"];

type Props = {
  active: boolean;
  onClose: () => void;
};

export const AnnotationOverlay = forwardRef<AnnotationOverlayHandle, Props>(
  ({ active, onClose }, ref) => {
    const {
      canvasRef,
      beginStroke,
      extendStroke,
      endStroke,
      undo,
      redo,
      clear,
      resize,
    } = useAnnotationCanvas();

    const [tool, setTool] = useState<AnnotationTool>("pen");
    const [color, setColor] = useState(COLORS[0]);
    const [size, setSize] = useState(4);
    const [textPrompt, setTextPrompt] = useState<{ x: number; y: number } | null>(null);
    const [textValue, setTextValue] = useState("");
    const toolRef = useRef(tool);
    const colorRef = useRef(color);
    const sizeRef = useRef(size);
    useEffect(() => { toolRef.current = tool; }, [tool]);
    useEffect(() => { colorRef.current = color; }, [color]);
    useEffect(() => { sizeRef.current = size; }, [size]);

    useImperativeHandle(ref, () => ({
      getCanvas: () => canvasRef.current,
    }));

    // Re-measure when activated
    useEffect(() => {
      if (active) requestAnimationFrame(resize);
    }, [active, resize]);

    // Hotkeys
    useEffect(() => {
      if (!active) return;
      const onKey = (e: KeyboardEvent) => {
        if (textPrompt) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === "z") {
          e.preventDefault();
          if (e.shiftKey) redo(); else undo();
          return;
        }
        if (k === "p") setTool("pen");
        else if (k === "h") setTool("highlighter");
        else if (k === "e") setTool("eraser");
        else if (k === "l") setTool("laser");
        else if (k === "t") setTool("text");
        else if (k === "a") setTool("arrow");
        else if (k === "r") setTool("rect");
        else if (k === "o") setTool("ellipse");
        else if (k === "escape") clear();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [active, undo, redo, clear, textPrompt]);

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = canvasRef.current;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (toolRef.current === "text") {
        setTextPrompt({ x, y });
        return;
      }
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      beginStroke(toolRef.current, colorRef.current, sizeRef.current, x, y);
    };
    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.buttons === 0) return;
      if (toolRef.current === "text") return;
      const c = canvasRef.current;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      extendStroke(e.clientX - rect.left, e.clientY - rect.top);
    };
    const onPointerUp = () => {
      if (toolRef.current === "text") return;
      endStroke();
    };

    const submitText = () => {
      if (textPrompt && textValue.trim()) {
        beginStroke("text", colorRef.current, sizeRef.current, textPrompt.x, textPrompt.y, textValue);
      }
      setTextPrompt(null);
      setTextValue("");
    };

    if (!active) return null;

    return (
      <div className="fixed inset-0 z-50 pointer-events-none">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-auto cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />

        {/* Floating toolbar */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-auto">
          <div className="flex items-center gap-1 px-2 py-1.5 rounded-full bg-card/95 backdrop-blur border border-border shadow-lg">
            <ToolBtn label="Pen (P)" active={tool === "pen"} onClick={() => setTool("pen")}><Pen className="size-4" /></ToolBtn>
            <ToolBtn label="Highlighter (H)" active={tool === "highlighter"} onClick={() => setTool("highlighter")}><Highlighter className="size-4" /></ToolBtn>
            <ToolBtn label="Eraser (E)" active={tool === "eraser"} onClick={() => setTool("eraser")}><Eraser className="size-4" /></ToolBtn>
            <ToolBtn label="Laser (L)" active={tool === "laser"} onClick={() => setTool("laser")}><Pointer className="size-4" /></ToolBtn>
            <div className="w-px h-5 bg-border mx-1" />
            <ToolBtn label="Arrow (A)" active={tool === "arrow"} onClick={() => setTool("arrow")}><ArrowUpRight className="size-4" /></ToolBtn>
            <ToolBtn label="Rectangle (R)" active={tool === "rect"} onClick={() => setTool("rect")}><SquareIcon className="size-4" /></ToolBtn>
            <ToolBtn label="Ellipse (O)" active={tool === "ellipse"} onClick={() => setTool("ellipse")}><CircleIcon className="size-4" /></ToolBtn>
            <ToolBtn label="Line" active={tool === "line"} onClick={() => setTool("line")}><Minus className="size-4" /></ToolBtn>
            <ToolBtn label="Text (T)" active={tool === "text"} onClick={() => setTool("text")}><Type className="size-4" /></ToolBtn>
            <div className="w-px h-5 bg-border mx-1" />
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`size-5 rounded-full border-2 transition ${color === c ? "border-foreground scale-110" : "border-border"}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
              />
            ))}
            <div className="w-px h-5 bg-border mx-1" />
            <input
              type="range"
              min={1}
              max={20}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="w-20 accent-primary"
              aria-label="Brush size"
            />
            <div className="w-px h-5 bg-border mx-1" />
            <ToolBtn label="Undo (⌘Z)" onClick={undo}><Undo2 className="size-4" /></ToolBtn>
            <ToolBtn label="Redo (⇧⌘Z)" onClick={redo}><Redo2 className="size-4" /></ToolBtn>
            <ToolBtn label="Clear (Esc)" onClick={clear}><Trash2 className="size-4" /></ToolBtn>
            <ShortcutDialog />
            <ToolBtn label="Close" onClick={onClose}><X className="size-4" /></ToolBtn>
          </div>
        </div>

        {textPrompt && (
          <div
            className="absolute pointer-events-auto"
            style={{ left: textPrompt.x, top: textPrompt.y }}
          >
            <input
              autoFocus
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onBlur={submitText}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitText();
                if (e.key === "Escape") { setTextPrompt(null); setTextValue(""); }
              }}
              placeholder="Type and press Enter…"
              className="px-2 py-1 rounded border-2 border-primary bg-background text-foreground shadow-lg outline-none"
              style={{ color, fontSize: `${Math.max(14, size * 6)}px` }}
            />
          </div>
        )}
      </div>
    );
  },
);
AnnotationOverlay.displayName = "AnnotationOverlay";

const ToolBtn = ({
  children,
  label,
  active,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) => (
  <button
    title={label}
    aria-label={label}
    onClick={onClick}
    className={`size-8 rounded-md flex items-center justify-center transition ${
      active ? "bg-primary text-primary-foreground" : "hover:bg-muted text-foreground"
    }`}
  >
    {children}
  </button>
);

const ShortcutDialog = () => (
  <Dialog>
    <DialogTrigger asChild>
      <button title="Shortcuts (?)" className="size-8 rounded-md flex items-center justify-center hover:bg-muted text-foreground">
        <Keyboard className="size-4" />
      </button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Annotation shortcuts</DialogTitle>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-y-2 text-sm">
        <Row k="P" v="Pen" />
        <Row k="H" v="Highlighter" />
        <Row k="E" v="Eraser" />
        <Row k="L" v="Laser pointer" />
        <Row k="A" v="Arrow" />
        <Row k="R" v="Rectangle" />
        <Row k="O" v="Ellipse" />
        <Row k="T" v="Text" />
        <Row k="⌘/Ctrl + Z" v="Undo" />
        <Row k="⇧⌘/Ctrl + Z" v="Redo" />
        <Row k="Esc" v="Clear all" />
      </div>
    </DialogContent>
  </Dialog>
);
const Row = ({ k, v }: { k: string; v: string }) => (
  <>
    <kbd className="px-2 py-0.5 rounded bg-muted text-xs font-mono w-fit">{k}</kbd>
    <span className="text-muted-foreground">{v}</span>
  </>
);
