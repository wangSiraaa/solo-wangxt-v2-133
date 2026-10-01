import type {
  Edge,
  LoopEdgeRef,
  Notch,
  Piece,
  ProjectData,
  Vec,
} from '../model/types';
import {
  adaptiveFlattenParams,
  bezierPoint,
  edgePointAt,
  edgeTangentAt,
} from '../geometry/bezier';
import { leftNormal } from '../geometry/vec';

/** 一段离散折线对应回源边的参数区间（t 沿环的穿行方向）。 */
export interface FlattenSegment {
  edgeId: string;
  /** 该折线顶点对应边【存储方向】的参数（含端点）。 */
  tStore: number;
  /** 该顶点对应环穿行方向的参数。 */
  tWalk: number;
}

export interface PlacedNotch {
  id: string;
  edgeId: string;
  t: number;
  pos: Vec;
  /** 世界坐标下记号指向的法向（含 normalSide），转移后须仍指向缝份外侧。 */
  normal: Vec;
  tangent: Vec;
  kind: Notch['kind'];
  pointId?: string;
}

export interface DerivedPiece {
  pieceId: string;
  /** 环穿行方向的闭合折线（首点不重复）。 */
  seamPolyline: Vec[];
  /** 每个折线顶点回指源特征（折线顶点数 == 映射条数，去重前的完整序列）。 */
  vertexRefs: { pointId: string | null; edgeId: string; tStore: number }[];
  notches: PlacedNotch[];
  dartLegs: { dartId: string; polyline: Vec[]; legIn: boolean; legOut: boolean }[];
  grainline: { at: Vec; angle: number; length: number };
  areaSigned: number;
  bbox: { min: Vec; max: Vec };
}

/** 沿环穿行方向取得一条边的离散点（始终包含两端点）。 */
export function flattenEdgeWalk(
  data: ProjectData,
  ref: LoopEdgeRef,
  tolerance = 0.08,
): { points: Vec[]; tStore: number[] } {
  const edge = data.edges[ref.edgeId];
  const a = data.points[edge.from].pos;
  const b = data.points[edge.to].pos;

  const store = (t: number): Vec =>
    edge.curve === 'line'
      ? edgePointAt(edge, a, b, t)
      : bezierPoint(edge, a, b, t);

  const tsStore = edge.curve === 'cubic' ? adaptiveFlattenParams(edge, a, b, tolerance) : [];
  const all = [0, ...tsStore, 1];

  if (!ref.reversed) {
    return { points: all.map((t) => store(t)), tStore: all };
  }
  // 穿行方向与存储方向相反：点序与 t 都翻转，但记号仍按存储 t 绑定。
  const rev = [...all].reverse();
  return { points: rev.map((t) => store(t)), tStore: rev };
}

export function rebuildPiece(data: ProjectData, piece: Piece): DerivedPiece {
  const { pointIds, edges } = piece.loop;
  const seamPolyline: Vec[] = [];
  const vertexRefs: DerivedPiece['vertexRefs'] = [];

  edges.forEach((ref, i) => {
    const startPointId = pointIds[i];
    void startPointId;
    const { points, tStore } = flattenEdgeWalk(data, ref);
    points.forEach((p, k) => {
      const isEnd = k === points.length - 1;
      if (isEnd && i < edges.length - 1) return; // 与下条边的起点重合，跳过
      if (isEnd && i === edges.length - 1) return; // 闭合首点
      seamPolyline.push(p);
      vertexRefs.push({
        pointId: k === 0 ? endpointId(data.edges[ref.edgeId], ref, true) : null,
        edgeId: ref.edgeId,
        tStore: tStore[k],
      });
    });
  });

  // 首顶点补特征点 id。
  const firstRef = edges[0];
  vertexRefs[0].pointId = endpointId(data.edges[firstRef.edgeId], firstRef, true);

  const notches: PlacedNotch[] = [];
  for (const n of Object.values(data.notches)) {
    if (!edgeOnPiece(n.edgeId, piece)) continue;
    const ref = edges.find((r) => r.edgeId === n.edgeId)!;
    notches.push(placeNotch(data, n, ref));
  }

  const dartLegs: DerivedPiece['dartLegs'] = [];
  for (const dartId of piece.dartIds) {
    const dart = data.darts[dartId];
    if (!dart) continue;
    const legs = [
      { id: dart.legIn, legIn: true, legOut: false },
      { id: dart.legOut, legIn: false, legOut: true },
    ];
    for (const leg of legs) {
      const e = data.edges[leg.id];
      if (!e) continue;
      const { points } = flattenEdgeWalk(data, { edgeId: e.id, reversed: false });
      dartLegs.push({ dartId, polyline: points, legIn: leg.legIn, legOut: leg.legOut });
    }
  }

  const areaSigned = polygonAreaSigned(seamPolyline);
  const bbox = polygonBBox(seamPolyline);

  return {
    pieceId: piece.id,
    seamPolyline,
    vertexRefs,
    notches,
    dartLegs,
    grainline: { ...piece.grainline },
    areaSigned,
    bbox,
  };
}

function endpointId(edge: Edge, ref: LoopEdgeRef, walkStart: boolean): string {
  // 环穿行起点：reversed=false -> from；reversed=true -> to
  const takeFrom = walkStart ? !ref.reversed : ref.reversed;
  return takeFrom ? edge.from : edge.to;
}

function edgeOnPiece(edgeId: string, piece: Piece): boolean {
  return piece.loop.edges.some((r) => r.edgeId === edgeId);
}

function placeNotch(data: ProjectData, n: Notch, ref: LoopEdgeRef): PlacedNotch {
  const edge = data.edges[n.edgeId];
  const a = data.points[edge.from].pos;
  const b = data.points[edge.to].pos;
  const pos = edgePointAt(edge, a, b, n.t);
  const storeTan = edgeTangentAt(edge, a, b, n.t);
  // 环穿行方向决定屏幕记号朝向；normalSide 相对存储方向的语义保持不变。
  const walkSign = ref.reversed ? -1 : 1;
  const tangent = walkSign === 1 ? storeTan : { x: -storeTan.x, y: -storeTan.y };
  const left = leftNormal(storeTan);
  const normal = { x: left.x * n.normalSide, y: left.y * n.normalSide };
  return {
    id: n.id,
    edgeId: n.edgeId,
    t: n.t,
    pos,
    normal,
    tangent,
    kind: n.kind,
    pointId: n.pointId,
  };
}

export function polygonAreaSigned(poly: Vec[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonBBox(poly: Vec[]): { min: Vec; max: Vec } {
  const min = { x: Infinity, y: Infinity };
  const max = { x: -Infinity, y: -Infinity };
  for (const p of poly) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
  }
  return { min, max };
}

/**
 * 几何指纹：源模型拓扑+坐标的稳定哈希。worker 结果按指纹缓存，
 * 且回包时主线程用它做代次核对（迟到结果不得覆盖新几何）。
 */
export function geometryFingerprint(data: ProjectData, pieceId: string, allowance: number): string {
  const piece = data.pieces[pieceId];
  const parts: string[] = [pieceId, allowance.toFixed(4)];
  for (const ref of piece.loop.edges) {
    const e = data.edges[ref.edgeId];
    parts.push(`${ref.edgeId}${ref.reversed ? 'r' : 'f'}`);
    const a = data.points[e.from].pos;
    const b = data.points[e.to].pos;
    parts.push(`${e.from}@${a.x.toFixed(4)},${a.y.toFixed(4)}`);
    parts.push(`${e.to}@${b.x.toFixed(4)},${b.y.toFixed(4)}`);
    if (e.curve === 'cubic') {
      parts.push(`c${e.c1.x.toFixed(4)},${e.c1.y.toFixed(4)};${e.c2.x.toFixed(4)},${e.c2.y.toFixed(4)}`);
    }
  }
  return hashString(parts.join('|'));
}

export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
