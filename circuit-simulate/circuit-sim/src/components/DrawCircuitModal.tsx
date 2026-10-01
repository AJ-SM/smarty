import { useEffect, useRef, useState } from "react";
import { useCircuitStore } from "../store/circuitStore";
import { generateCircuitFromImage } from "../api/generateCircuit";

/** Internal drawing resolution. The canvas is scaled down to fit on screen
 *  but exported at this size so the model sees a reasonably large image. */
const CANVAS_W = 1600;
const CANVAS_H = 1000;

type Tool = "pen" | "eraser";

interface Stroke {
  tool: Tool;
  width: number;
  points: { x: number; y: number }[];
}

interface DrawCircuitModalProps {
  onClose: () => void;
}

export function DrawCircuitModal({ onClose }: DrawCircuitModalProps) {
  const loadNetlist = useCircuitStore((s) => s.loadNetlist);
  const clearAll = useCircuitStore((s) => s.clearAll);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const activeRef = useRef<Stroke | null>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const [penWidth, setPenWidth] = useState(5);
  const [strokeCount, setStrokeCount] = useState(0);
  const [status, setStatus] = useState<"idle" | "generating">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    redraw();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Paint strokes onto a transparent layer. The eraser cuts ink away
   *  (destination-out) rather than painting a background colour over it,
   *  so the same strokes render on the dark screen and the white export. */
  function paintStrokes(ctx: CanvasRenderingContext2D, ink: string) {
    const all = activeRef.current
      ? [...strokesRef.current, activeRef.current]
      : strokesRef.current;
    for (const s of all) {
      if (s.points.length === 0) continue;
      ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      ctx.lineWidth = s.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (s.points.length === 1) {
        const p = s.points[0];
        ctx.beginPath();
        ctx.arc(p.x, p.y, s.width / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function redraw() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // Dark grid background comes from CSS; the canvas only holds the ink.
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    const ink = getComputedStyle(canvas).getPropertyValue("--phosphor").trim() || "#6effb0";
    paintStrokes(ctx, ink);
  }

  /** The model was trained on ink-on-paper photos, so export the drawing
   *  as black strokes on white regardless of the on-screen theme. */
  function exportForModel(): string {
    const layer = document.createElement("canvas");
    layer.width = CANVAS_W;
    layer.height = CANVAS_H;
    paintStrokes(layer.getContext("2d")!, "#111111");

    const out = document.createElement("canvas");
    out.width = CANVAS_W;
    out.height = CANVAS_H;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.drawImage(layer, 0, 0);
    return out.toDataURL("image/png");
  }

  function toCanvasPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (status === "generating") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    activeRef.current = {
      tool,
      width: tool === "eraser" ? penWidth * 6 : penWidth,
      points: [toCanvasPoint(e)],
    };
    redraw();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!activeRef.current) return;
    activeRef.current.points.push(toCanvasPoint(e));
    redraw();
  }

  function handlePointerUp() {
    if (!activeRef.current) return;
    strokesRef.current.push(activeRef.current);
    activeRef.current = null;
    setStrokeCount(strokesRef.current.length);
    redraw();
  }

  function undo() {
    strokesRef.current.pop();
    setStrokeCount(strokesRef.current.length);
    redraw();
  }

  function clear() {
    strokesRef.current = [];
    setStrokeCount(0);
    setError(null);
    redraw();
  }

  async function handleGenerate() {
    setStatus("generating");
    setError(null);
    try {
      const netlist = await generateCircuitFromImage(exportForModel());
      if (!netlist.components?.length) {
        throw new Error(
          "The model found symbols but couldn't connect them into a circuit. " +
            "Make sure every wire touches the component ends."
        );
      }
      // Wipe the previous schematic completely before placing the new one.
      clearAll();
      const skipped = loadNetlist(netlist);
      if (skipped.length > 0) {
        alert(
          `Circuit generated.\n\nThese detected parts aren't drawable on the canvas yet and were skipped:\n  ${skipped.join(", ")}`
        );
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
    }
  }

  const busy = status === "generating";

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal draw-modal" role="dialog" aria-modal="true" aria-labelledby="draw-modal-title">
        <div className="modal-header">
          <div>
            <h2 id="draw-modal-title" className="modal-title">Draw a circuit</h2>
            <p className="hint-text" style={{ margin: 0 }}>
              Sketch resistors, capacitors, inductors, sources and ground, join them with wires,
              then press Generate.
            </p>
          </div>
          <button className="btn btn-xs" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="draw-toolbar">
          <div className="view-toggle" role="group" aria-label="Drawing tool">
            <button
              className={`view-toggle-btn${tool === "pen" ? " active" : ""}`}
              onClick={() => setTool("pen")}
            >
              ✎ Pen
            </button>
            <button
              className={`view-toggle-btn${tool === "eraser" ? " active" : ""}`}
              onClick={() => setTool("eraser")}
            >
              ⌫ Eraser
            </button>
          </div>

          <label className="draw-width">
            <span className="field-label">Width</span>
            <input
              type="range"
              min={2}
              max={12}
              value={penWidth}
              onChange={(e) => setPenWidth(Number(e.target.value))}
            />
          </label>

          <button className="btn btn-xs" onClick={undo} disabled={busy || strokeCount === 0}>
            ↶ Undo
          </button>
          <button className="btn btn-xs btn-danger" onClick={clear} disabled={busy || strokeCount === 0}>
            Clear
          </button>
        </div>

        <div className="draw-surface">
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className={`draw-canvas${tool === "eraser" ? " erasing" : ""}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />
          {busy && (
            <div className="draw-busy">
              <span>Recognising circuit…</span>
            </div>
          )}
        </div>

        {error && <div className="result-box result-error">{error}</div>}

        <div className="modal-footer">
          <span className="hint-text">
            Generating clears the current schematic and replaces it with the new circuit.
          </span>
          <button
            className="btn-primary draw-generate"
            onClick={handleGenerate}
            disabled={busy || strokeCount === 0}
          >
            {busy ? "Generating…" : "⚡ Generate Circuit"}
          </button>
        </div>
      </div>
    </div>
  );
}
