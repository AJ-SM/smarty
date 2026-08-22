import { GRID_SIZE, orthogonalPath } from "../utils/geometry";

interface Props {
  points: { x: number; y: number }[]; // grid units, already resolved
  selected: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}

export function WireView({ points, selected, onPointerDown }: Props) {
  if (points.length < 2) return null;
  const [a, b] = points;
  const routed = orthogonalPath(a, b).map((p) => ({
    x: p.x * GRID_SIZE,
    y: p.y * GRID_SIZE,
  }));
  const d = routed.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <g>
      {/* wide invisible hit target, since the visible trace is thin */}
      <path d={d} stroke="transparent" strokeWidth={14} fill="none" onPointerDown={onPointerDown} style={{ cursor: "pointer" }} />
      <path
        d={d}
        stroke={selected ? "var(--amber)" : "var(--phosphor)"}
        strokeWidth={selected ? 2.5 : 2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      />
    </g>
  );
}
