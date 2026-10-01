import type { ComponentInstance, PinDef, Rotation } from "../types/circuit";

/** Size, in screen pixels, of one grid unit. Every coordinate stored in
 *  the document is in grid units; this is the only place px-per-unit lives. */
export const GRID_SIZE = 24;

export function snap(value: number): number {
  return Math.round(value);
}

export function gridToPx(value: number): number {
  return value * GRID_SIZE;
}

export function pxToGrid(value: number): number {
  return value / GRID_SIZE;
}

/** Rotate a local point by a component's rotation, then apply mirroring
 *  (mirror flips the local X axis before rotation, matching how most
 *  schematic tools define "flip horizontal"). Returns local-space point. */
export function transformLocal(
  local: { x: number; y: number },
  rotation: Rotation,
  mirrored: boolean
): { x: number; y: number } {
  let { x, y } = local;
  if (mirrored) x = -x;

  const rad = (rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  };
}

/** Resolve a pin's absolute position (grid units) for a placed component. */
export function resolvePinWorld(
  component: ComponentInstance,
  pin: PinDef
): { x: number; y: number } {
  const t = transformLocal(pin.local, component.rotation, component.mirrored);
  return { x: component.x + t.x, y: component.y + t.y };
}

export function distance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Unit direction a pin points out of its component (e.g. {0,-1} for the
 *  top pin of a vertical part), used to route wires away from the body. */
export function pinDirection(
  component: ComponentInstance,
  pin: PinDef
): { x: number; y: number } {
  const t = transformLocal(pin.local, component.rotation, component.mirrored);
  return { x: Math.sign(t.x), y: Math.sign(t.y) };
}

type Pt = { x: number; y: number };

/** Build an orthogonal (Manhattan) path between two points. When the pins'
 *  outward directions are known the wire leaves each pin along its axis:
 *  one elbow (L) when the pins face across each other, two (Z) when they
 *  are parallel. Without directions it leaves horizontally first — reads
 *  well for the common case of left/right two-terminal parts. */
export function orthogonalPath(a: Pt, b: Pt, dirA?: Pt, dirB?: Pt): Pt[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  const aVertical = !!dirA && dirA.x === 0 && dirA.y !== 0;
  const bVertical = dirB ? dirB.x === 0 && dirB.y !== 0 : aVertical;

  if (dirA && aVertical !== bVertical) {
    // L-shape: leave `a` along its own axis, arrive at `b` along its axis.
    return aVertical ? [a, { x: a.x, y: b.y }, b] : [a, { x: b.x, y: a.y }, b];
  }
  if (aVertical && bVertical) {
    const midY = (a.y + b.y) / 2;
    return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
  }
  const midX = (a.x + b.x) / 2;
  return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
}
