/**
 * Parses the external JSON netlist format and converts it into the internal
 * ComponentInstance[] + Wire[] representation for the schematic canvas.
 *
 * Coordinate methodology (mirrors CircuitJS grid-snap approach):
 *   1. Collect all pin pixel coordinates from component_details.
 *   2. Cluster nearby X and Y values within a 50 px tolerance → unified values,
 *      ensuring components on the same rail align perfectly.
 *   3. Build a pixel→grid transform from the clustered extents.
 *   4. Snap each grid value to the nearest integer (equivalent to
 *      round(coord / (S × GRID_STEP)) × GRID_STEP in CircuitJS terms).
 *   5. Reconstruct wire topology directly from pin net_id fields — avoids
 *      fragmented/disjointed raw segment geometry.
 *
 * Supports two flavours of the format:
 *
 * ── NEW (rich) format ────────────────────────────────────────────────────────
 * Includes `component_details` (pixel bboxes + pin pixel coords) and
 * optionally `wires.segments` / `wires.junctions`.
 * Wire routing: net_id on each pin → group → chain → Wire[].  Falls back to
 * segment union-find, then net-array inference.
 *
 * ── OLD (simple) format ──────────────────────────────────────────────────────
 * Only has `components` + `nets`.
 * Layout  : auto-grid (4-column).
 * Wiring  : chain pins that share the same net.
 */

import { v4 as uuid } from "uuid";
import type { ComponentInstance, ComponentKind, Wire, PinRef } from "../types/circuit";
import { getDef } from "../domain/componentDefs";
import { snap } from "./geometry";

// ─── External JSON types ──────────────────────────────────────────────────────

export interface JsonNet {
  id: string;
  pins: string[]; // e.g. ["R1.A", "V1.+"]
}

export interface JsonComponent {
  ref_des: string;
  type: string;
  value: string;
  net_pos: string;
  net_neg: string;
  spice_line: string;
}

export interface JsonWireSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface JsonWires {
  segments: JsonWireSegment[];
  junctions?: { x: number; y: number }[];
  endpoints?: { x: number; y: number }[];
}

export interface JsonPinDetail {
  name: string;
  x: number; // pixel position in original image
  y: number;
  net_id?: string;
}

export interface JsonComponentDetail {
  ref_des: string;
  type: string;
  bbox: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    cx: number; // centre pixel X
    cy: number; // centre pixel Y
  };
  conf: number;
  pins: JsonPinDetail[];
}

/** Grid / scale metadata emitted by the v2 backend pipeline. */
export interface JsonGrid {
  /** CircuitJS grid snap size in pixels (always 16). */
  circuitjs_grid: number;
  /** pixels → CircuitJS units: cjsX = pin.x * scale_x */
  scale_x: number;
  /** pixels → CircuitJS units: cjsY = pin.y * scale_y */
  scale_y: number;
}

export interface JsonNetlist {
  title?: string;
  timestamp?: string;
  image?: { width: number; height: number };
  /** v2 backend: pre-computed scale factors for CircuitJS coordinate mapping. */
  grid?: JsonGrid;
  /** v1 backend only: raw wire pixel segments (removed in v2). */
  wires?: JsonWires;
  nets?: JsonNet[];
  components: JsonComponent[];
  component_details?: JsonComponentDetail[];
}

// ─── Load result ──────────────────────────────────────────────────────────────

/** A wire segment already converted to grid-unit space, ready for SVG rendering. */
export interface RawWireSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A junction dot in grid-unit space. */
export interface RawJunction {
  x: number;
  y: number;
}

export interface LoadResult {
  components: ComponentInstance[];
  wires: Wire[];
  skipped: string[]; // ref_des of unsupported component types
  /** Raw wire segments scaled to grid units (mirrors wires.segments from JSON). */
  rawWireSegments: RawWireSegment[];
  /** Junction dots scaled to grid units (mirrors wires.junctions from JSON). */
  rawJunctions: RawJunction[];
}

// ─── Type mapping ─────────────────────────────────────────────────────────────

function typeToKind(type: string): ComponentKind | null {
  switch (type.toLowerCase().trim()) {
    case "resistor":    return "resistor";
    case "capacitor":   return "capacitor";
    case "inductor":    return "inductor";
    case "voltage":
    case "vsource":
    case "vsource_dc":
    case "dc voltage":
    case "dc":          return "vsource_dc";
    case "vsource_ac":
    case "ac voltage":
    case "ac":          return "vsource_ac";
    case "ground":
    case "gnd":         return "ground";
    default:            return null; // Diode, transistor, etc. not yet in canvas
  }
}

// ─── Value parsing ────────────────────────────────────────────────────────────

function parseValue(val: string): number {
  // Handle "DC 5", "AC 12", etc. — strip leading qualifier
  const stripped = val.replace(/^(dc|ac)\s+/i, "").trim();
  const m = stripped.match(/^([0-9.]+)\s*([kmupnfMGTPEZYKμ]?)/i);
  if (!m) return parseFloat(stripped) || 0;
  const num = parseFloat(m[1]);
  const sfx: Record<string, number> = {
    T: 1e12, G: 1e9, M: 1e6, k: 1e3, K: 1e3,
    "": 1,
    m: 1e-3, u: 1e-6, μ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  };
  return num * (sfx[m[2]] ?? 1);
}

function buildParams(kind: ComponentKind, value: string): Record<string, number> {
  const def = getDef(kind);
  const base: Record<string, number> = Object.fromEntries(
    def.params.map((p) => [p.key, p.default])
  );
  const num = parseValue(value);
  if (num !== 0 && def.params.length > 0) {
    base[def.params[0].key] = num;
  }
  return base;
}

// ─── Coordinate transform (pixel → grid) ─────────────────────────────────────

const CANVAS_MARGIN = 4;  // grid units of padding around the placed circuit
const TARGET_W      = 52; // target canvas width in grid units
const TARGET_H      = 44; // target canvas height in grid units

/** Tolerance (px) within which two coordinates are considered the same rail. */
const CLUSTER_TOLERANCE_PX = 50;

export interface PixelToGrid {
  toGrid: (px: number, py: number) => { x: number; y: number };
  /** Variant that applies coordinate clustering before converting. */
  toGridClustered: (px: number, py: number) => { x: number; y: number };
  scale: number; // grid-units per pixel
}

/**
 * Group a list of numeric values so that any two values within `tolerance` of
 * the cluster's seed are merged.  Returns a Map from each original value to its
 * cluster representative (the median of the cluster).
 *
 * Example: [1497, 1534, 800] with tolerance=50 →
 *   1497 → 1516 (median of [1497,1534]), 1534 → 1516, 800 → 800
 */
export function clusterValues(
  values: number[],
  tolerance: number
): Map<number, number> {
  const unique = [...new Set(values)].sort((a, b) => a - b);
  const result = new Map<number, number>();
  let i = 0;
  while (i < unique.length) {
    // Grow cluster while consecutive values differ from seed by ≤ tolerance.
    let j = i + 1;
    while (j < unique.length && unique[j] - unique[i] <= tolerance) j++;
    const group = unique.slice(i, j);
    const rep = group[Math.floor(group.length / 2)]; // median
    for (const v of group) result.set(v, rep);
    i = j;
  }
  return result;
}

/**
 * Build a linear mapping from image pixel space → canvas grid space.
 * Pass `pinPixels` (all raw pin X/Y values collected from component_details)
 * so the transform can pre-cluster nearby coordinates before snapping, matching
 * the methodology: round(coord / (S × GRID_STEP)) × GRID_STEP.
 */
export function buildPixelToGrid(
  details: JsonComponentDetail[],
  pinPixels?: { xs: number[]; ys: number[] }
): PixelToGrid {
  // Build cluster maps in pixel space (50 px tolerance)
  const allXs = pinPixels?.xs ?? details.map((d) => d.bbox.cx);
  const allYs = pinPixels?.ys ?? details.map((d) => d.bbox.cy);
  const xCluster = clusterValues(allXs, CLUSTER_TOLERANCE_PX);
  const yCluster = clusterValues(allYs, CLUSTER_TOLERANCE_PX);

  // Derive extents from clustered values so the scale fits the snapped layout.
  const clusteredXs = [...new Set([...xCluster.values()])];
  const clusteredYs = [...new Set([...yCluster.values()])];
  const minX = Math.min(...clusteredXs);
  const minY = Math.min(...clusteredYs);
  const maxX = Math.max(...clusteredXs);
  const maxY = Math.max(...clusteredYs);

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const innerW = TARGET_W - CANVAS_MARGIN * 2;
  const innerH = TARGET_H - CANVAS_MARGIN * 2;

  // Uniform scale so the schematic isn't distorted.
  const scale = Math.min(innerW / rangeX, innerH / rangeY);

  // Centre the circuit within the target area.
  const offsetX = CANVAS_MARGIN + (innerW - rangeX * scale) / 2 - minX * scale;
  const offsetY = CANVAS_MARGIN + (innerH - rangeY * scale) / 2 - minY * scale;

  const rawToGrid = (px: number, py: number) => ({
    x: snap(px * scale + offsetX),
    y: snap(py * scale + offsetY),
  });

  const clusteredToGrid = (px: number, py: number) => {
    const cx = xCluster.get(px) ?? px;
    const cy = yCluster.get(py) ?? py;
    return rawToGrid(cx, cy);
  };

  return { toGrid: rawToGrid, toGridClustered: clusteredToGrid, scale };
}

// ─── Fallback auto-layout (old format, no component_details) ─────────────────

function autoLayout(count: number): { x: number; y: number }[] {
  const COLS = 4;
  const COL_STEP = 6;
  const ROW_STEP = 5;
  const START_X = 6;
  const START_Y = 6;
  return Array.from({ length: count }, (_, i) => ({
    x: snap(START_X + (i % COLS) * COL_STEP),
    y: snap(START_Y + Math.floor(i / COLS) * ROW_STEP),
  }));
}

// ─── Topology-aware layout ────────────────────────────────────────────────

/** Internal pairing of a placed instance with its raw JSON data. */
interface MappedComp {
  instance: ComponentInstance;
  jsonComp: JsonComponent;
}

/**
 * Walk the series chain through the circuit graph defined by each component's
 * `net_pos` / `net_neg` terminals.  Starts from the voltage source (preferred)
 * and follows shared nets to discover the traversal order.
 *
 * Returns all mapped components in chain order; any orphaned (disconnected)
 * components are appended at the end.
 */
function traceSeriesChain(mapped: MappedComp[]): MappedComp[] {
  if (mapped.length === 0) return [];

  // net_id → [ref_des] of all components that touch that net
  const netToRefs = new Map<string, string[]>();
  for (const m of mapped) {
    for (const net of [m.jsonComp.net_pos, m.jsonComp.net_neg]) {
      if (!net) continue;
      if (!netToRefs.has(net)) netToRefs.set(net, []);
      netToRefs.get(net)!.push(m.jsonComp.ref_des);
    }
  }

  const refMap = new Map(mapped.map((m) => [m.jsonComp.ref_des, m]));

  // Prefer starting with a voltage source so schematic reads "V first".
  const startM =
    mapped.find((m) => m.instance.kind.startsWith("vsource")) ?? mapped[0];

  const chain: MappedComp[] = [startM];
  const visited = new Set<string>([startM.jsonComp.ref_des]);

  // Walk from the negative terminal outward through the loop.
  let currentNet = startM.jsonComp.net_neg ?? startM.jsonComp.net_pos ?? "";

  for (let step = 0; step < mapped.length - 1; step++) {
    const next = (netToRefs.get(currentNet) ?? []).find((r) => !visited.has(r));
    if (!next) break;
    const nextM = refMap.get(next)!;
    chain.push(nextM);
    visited.add(next);
    // Advance to the OTHER terminal of this component.
    currentNet =
      nextM.jsonComp.net_neg === currentNet
        ? (nextM.jsonComp.net_pos ?? "")
        : (nextM.jsonComp.net_neg ?? "");
  }

  // Append any orphaned / disconnected components.
  for (const m of mapped) {
    if (!visited.has(m.jsonComp.ref_des)) chain.push(m);
  }

  return chain;
}

/**
 * Assign grid positions to a chain of components so they form a neat
 * rectangular loop:
 *
 *   chain[0] ─ chain[1] ─ ─ chain[topN-1]
 *       |                          |
 *   chain[N-1] ─ ... ─ chain[topN]
 *
 * Components on the top branch go left→right; bottom branch right→left so
 * that adjacent pairs in chain order remain geometrically adjacent, keeping
 * the auto-routed wires short and straight.
 */
function placeInLoop(chain: MappedComp[]): void {
  const N = chain.length;
  if (N === 0) return;
  if (N === 1) {
    chain[0].instance.x = snap(TARGET_W / 2);
    chain[0].instance.y = snap(TARGET_H / 2);
    return;
  }

  const topN = Math.ceil(N / 2);
  const botN = N - topN;

  // Horizontal step between successive components on the same branch.
  const STEP   = 10; // grid units
  const START_X = CANVAS_MARGIN + 2;
  const TOP_Y   = CANVAS_MARGIN + 4;
  const BOT_Y   = CANVAS_MARGIN + 4 + 12; // 12 grid-unit vertical gap

  for (let i = 0; i < topN; i++) {
    chain[i].instance.x = snap(START_X + i * STEP);
    chain[i].instance.y = snap(TOP_Y);
  }

  for (let i = 0; i < botN; i++) {
    // Mirror the top branch so chain[topN] is directly below chain[topN-1].
    chain[topN + i].instance.x = snap(START_X + (topN - 1 - i) * STEP);
    chain[topN + i].instance.y = snap(BOT_Y);
  }
}

// ─── Wire building: primary — net_id from component_details pins ──────────────

/**
 * PRIMARY wire builder (Rich format).
 * Reads `net_id` directly from each pin in `component_details`.  Because these
 * labels are assigned by the backend topology solver (not derived from fragile
 * pixel proximity), this is far more reliable than segment union-find.
 *
 * Pins sharing the same net_id are grouped; adjacent pairs in each group are
 * connected with a Wire. Falls back gracefully when net_id is absent.
 */
function buildWiresFromPinNetIds(
  details: JsonComponentDetail[],
  refToInstance: Map<string, ComponentInstance>
): Wire[] {
  const netToPins = new Map<string, PinRef[]>();

  for (const detail of details) {
    const inst = refToInstance.get(detail.ref_des);
    if (!inst) continue;
    const def = getDef(inst.kind);

    for (const pinDetail of detail.pins) {
      if (!pinDetail.net_id) continue;
      const pinDef = def.pins.find(
        (p) => p.name.toLowerCase() === pinDetail.name.toLowerCase()
      );
      if (!pinDef) continue;
      const ref: PinRef = { componentId: inst.id, pinId: pinDef.id };
      if (!netToPins.has(pinDetail.net_id)) netToPins.set(pinDetail.net_id, []);
      netToPins.get(pinDetail.net_id)!.push(ref);
    }
  }

  const wires: Wire[] = [];
  const seenPairs = new Set<string>();

  function addWire(from: PinRef, to: PinRef) {
    const key = [`${from.componentId}:${from.pinId}`, `${to.componentId}:${to.pinId}`]
      .sort()
      .join("|");
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    wires.push({ id: uuid(), from, to });
  }

  for (const pins of netToPins.values()) {
    if (pins.length < 2) continue;
    // Chain the pins in this net so every adjacent pair gets a wire.
    for (let i = 0; i < pins.length - 1; i++) addWire(pins[i], pins[i + 1]);
  }

  return wires;
}

// ─── Wire building: secondary — segment union-find (pixel proximity) ──────────

/**
 * SECONDARY wire builder.  Used when pin net_id is absent but the JSON contains
 * detected wire segments.  Runs a union-find over segment endpoints + pin pixel
 * positions to determine physical connectivity.
 */
function buildWiresFromSegments(
  segments: JsonWireSegment[],
  details: JsonComponentDetail[],
  refToInstance: Map<string, ComponentInstance>,
  snapTolerance: number
): Wire[] {
  interface PoolPoint { x: number; y: number; id: number }
  const pool: PoolPoint[] = [];
  let nextPtId = 0;

  function findOrAdd(x: number, y: number): number {
    for (const p of pool) {
      if (Math.hypot(p.x - x, p.y - y) <= snapTolerance) return p.id;
    }
    const id = nextPtId++;
    pool.push({ x, y, id });
    return id;
  }

  // Register pin positions first so they anchor the clusters.
  const pinAtPoint = new Map<number, PinRef>();
  for (const detail of details) {
    const inst = refToInstance.get(detail.ref_des);
    if (!inst) continue;
    const def = getDef(inst.kind);
    for (const pinDetail of detail.pins) {
      const pinDef = def.pins.find(
        (p) => p.name.toLowerCase() === pinDetail.name.toLowerCase()
      );
      if (!pinDef) continue;
      const ptId = findOrAdd(pinDetail.x, pinDetail.y);
      if (!pinAtPoint.has(ptId))
        pinAtPoint.set(ptId, { componentId: inst.id, pinId: pinDef.id });
    }
  }

  // Register segment endpoints.
  const edges: { a: number; b: number }[] = [];
  for (const seg of segments) {
    edges.push({ a: findOrAdd(seg.x1, seg.y1), b: findOrAdd(seg.x2, seg.y2) });
  }

  // Union-Find
  const parent = Array.from({ length: nextPtId }, (_, i) => i);
  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (const { a, b } of edges) union(a, b);

  // Group pins by connected component
  const rootToPins = new Map<number, PinRef[]>();
  for (const [ptId, pinRef] of pinAtPoint) {
    const root = find(ptId);
    if (!rootToPins.has(root)) rootToPins.set(root, []);
    rootToPins.get(root)!.push(pinRef);
  }

  const wires: Wire[] = [];
  const seenPairs = new Set<string>();
  function addWire(from: PinRef, to: PinRef) {
    const key = [`${from.componentId}:${from.pinId}`, `${to.componentId}:${to.pinId}`]
      .sort().join("|");
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    wires.push({ id: uuid(), from, to });
  }
  for (const pins of rootToPins.values()) {
    if (pins.length < 2) continue;
    for (let i = 0; i < pins.length - 1; i++) addWire(pins[i], pins[i + 1]);
  }
  return wires;
}

// ─── Wire building: tertiary — net-array inference (old format) ───────────────

function buildWiresFromNets(
  nets: JsonNet[],
  refToInstance: Map<string, ComponentInstance>
): Wire[] {
  const wires: Wire[] = [];
  const seenPairs = new Set<string>();

  function addWire(from: PinRef, to: PinRef) {
    const key = [`${from.componentId}:${from.pinId}`, `${to.componentId}:${to.pinId}`]
      .sort().join("|");
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    wires.push({ id: uuid(), from, to });
  }

  for (const net of nets) {
    const refs: PinRef[] = [];
    for (const pinStr of net.pins) {
      const dotIdx = pinStr.lastIndexOf(".");
      if (dotIdx === -1) continue;
      const refDes = pinStr.slice(0, dotIdx);
      const pinName = pinStr.slice(dotIdx + 1);
      const inst = refToInstance.get(refDes);
      if (!inst) continue;
      const def = getDef(inst.kind);
      const pin = def.pins.find(
        (p) => p.name.toLowerCase() === pinName.toLowerCase()
      );
      if (!pin) continue;
      refs.push({ componentId: inst.id, pinId: pin.id });
    }
    for (let i = 0; i < refs.length - 1; i++) addWire(refs[i], refs[i + 1]);
  }

  return wires;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function loadNetlistJson(json: JsonNetlist): LoadResult {
  const skipped: string[] = [];
  const usedRefIds = new Set<string>();

  const mapped: MappedComp[] = [];

  for (const jc of json.components) {
    const kind = typeToKind(jc.type);
    if (!kind) {
      skipped.push(jc.ref_des);
      continue;
    }
    const refId = usedRefIds.has(jc.ref_des)
      ? `${jc.ref_des}_${uuid().slice(0, 4)}`
      : jc.ref_des;
    usedRefIds.add(refId);

    const instance: ComponentInstance = {
      id: uuid(),
      kind,
      refId,
      x: 0,
      y: 0,
      rotation: 0,
      mirrored: false,
      params: buildParams(kind, jc.value),
    };
    mapped.push({ instance, jsonComp: jc });
  }

  const refToInstance = new Map<string, ComponentInstance>(
    mapped.map((m) => [m.jsonComp.ref_des, m.instance])
  );

  // 2. Position components
  //
  //  Priority:
  //    a) Topology layout — when components carry net_pos/net_neg, trace the
  //       series chain and arrange in a clean rectangle.  This is the primary
  //       path for YOLO-detected netlists and produces straight-line wiring.
  //    b) Photo-coordinate layout — use bbox pixel positions when no net
  //       topology is available but component_details are present.
  //    c) Auto-grid — last resort for minimal old-format JSON.
  const details = json.component_details ?? [];
  const detailMap = new Map<string, JsonComponentDetail>(
    details.map((d) => [d.ref_des, d])
  );

  let p2g: PixelToGrid | null = null;

  const hasNetTopology = mapped.some(
    (m) => m.jsonComp.net_pos || m.jsonComp.net_neg
  );

  if (hasNetTopology) {
    const chain = traceSeriesChain(mapped);
    placeInLoop(chain);
  } else if (details.length > 0) {
    const allPinXs: number[] = [];
    const allPinYs: number[] = [];
    for (const d of details) {
      allPinXs.push(d.bbox.cx);
      allPinYs.push(d.bbox.cy);
      for (const pin of d.pins) {
        allPinXs.push(pin.x);
        allPinYs.push(pin.y);
      }
    }
    p2g = buildPixelToGrid(details, { xs: allPinXs, ys: allPinYs });
    mapped.forEach((m, idx) => {
      const detail = detailMap.get(m.jsonComp.ref_des);
      if (detail) {
        const g = p2g!.toGridClustered(detail.bbox.cx, detail.bbox.cy);
        m.instance.x = g.x;
        m.instance.y = g.y;
      } else {
        m.instance.x = snap(6 + idx * 6);
        m.instance.y = snap(2);
      }
    });
  } else {
    const positions = autoLayout(mapped.length);
    mapped.forEach((m, i) => {
      m.instance.x = positions[i].x;
      m.instance.y = positions[i].y;
    });
  }

  const components = mapped.map((m) => m.instance);

  let wires: Wire[] = [];

  const hasDetails  = details.length > 0;
  const hasSegments = (json.wires?.segments?.length ?? 0) > 0;

  const hasPinNetIds = hasDetails &&
    details.some((d) => d.pins.some((p) => !!p.net_id));

  if (hasPinNetIds) {
    wires = buildWiresFromPinNetIds(details, refToInstance);
  }

  if (wires.length === 0 && json.nets) {
    wires = buildWiresFromNets(json.nets, refToInstance);
  }

  if (wires.length === 0 && hasSegments && hasDetails && p2g) {
    const snapTolerance = Math.max((1 / p2g.scale) * 1.5, 80);
    wires = buildWiresFromSegments(
      json.wires!.segments,
      details,
      refToInstance,
      snapTolerance
    );
  }

  // 4. Convert raw wire segments + junctions to clustered grid units
  //    for the background trace layer.  Using toGridClustered ensures the
  //    rendered segments snap to the same aligned grid as the components.
  const rawWireSegments: RawWireSegment[] = [];
  const rawJunctions: RawJunction[] = [];

  if (p2g && hasSegments) {
    for (const seg of json.wires!.segments) {
      const a = p2g.toGridClustered(seg.x1, seg.y1);
      const b = p2g.toGridClustered(seg.x2, seg.y2);
      rawWireSegments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    for (const jct of json.wires!.junctions ?? []) {
      const g = p2g.toGridClustered(jct.x, jct.y);
      rawJunctions.push({ x: g.x, y: g.y });
    }
  }

  return { components, wires, skipped, rawWireSegments, rawJunctions };
}
