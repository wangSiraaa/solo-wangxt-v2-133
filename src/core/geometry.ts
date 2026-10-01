/**
 * 纯几何工具：三次贝塞尔、弧长参数化、离散环、多边形指标。
 * 全部为纯函数，主线程预校验 / worker / 测试共用同一实现。
 */
import type { Edge, Piece, Vec2 } from './types';

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => len(sub(a, b));
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const rotate = (p: Vec2, c: Vec2, ang: number): Vec2 => {
  const s = Math.sin(ang);
  const co = Math.cos(ang);
  const d = sub(p, c);
  return { x: c.x + d.x * co - d.y * s, y: c.y + d.x * s + d.y * co };
};

export function cubicPoint(e: Edge, verts: Record<string, Vec2>, t: number): Vec2 {
  const p0 = verts[e.from];
  const p3 = verts[e.to];
  if (!e.cubic) {
    return { x: p0.x + (p3.x - p0.x) * t, y: p0.y + (p3.y - p0.y) * t };
  }
  const { c1, c2 } = e.cubic;
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p0.x + b1 * c1.x + b2 * c2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * c1.y + b2 * c2.y + b3 * p3.y
  };
}

export function cubicTangent(e: Edge, verts: Record<string, Vec2>, t: number): Vec2 {
  const p0 = verts[e.from];
  const p3 = verts[e.to];
  if (!e.cubic) return sub(p3, p0);
  const { c1, c2 } = e.cubic;
  const u = 1 - t;
  const d: Vec2 = {
    x:
      3 * u * u * (c1.x - p0.x) +
      6 * u * t * (c2.x - c1.x) +
      3 * t * t * (p3.x - c2.x),
    y:
      3 * u * u * (c1.y - p0.y) +
      6 * u * t * (c2.y - c1.y) +
      3 * t * t * (p3.y - c2.y)
  };
  return d;
}

/**
 * 反转一条绝对三次曲线（新起点=旧终点）。
 * 三次贝塞尔反向仅需交换两个控制点：c1′=旧 c2, c2′=旧 c1。
 */
export function reverseCubicAbs(c: {
  p0: Vec2;
  c1: Vec2;
  c2: Vec2;
  p3: Vec2;
}): { p0: Vec2; c1: Vec2; c2: Vec2; p3: Vec2 } {
  return { p0: c.p3, c1: c.c2, c2: c.c1, p3: c.p0 };
}

/** 三次曲线速度向量 */
function cubicDerivative(e: Edge, verts: Record<string, Vec2>, t: number): Vec2 {
  const p0 = verts[e.from];
  const p3 = verts[e.to];
  if (!e.cubic) return { x: p3.x - p0.x, y: p3.y - p0.y };
  const { c1, c2 } = e.cubic;
  const u = 1 - t;
  return {
    x: 3 * u * u * (c1.x - p0.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (p3.x - c2.x),
    y: 3 * u * u * (c1.y - p0.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (p3.y - c2.y)
  };
}

// 8 点 Gauss–Legendre（区间 [-1,1]）
const GL8_T = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363
];
const GL8_W = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362,
  0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763
];

/** 三次曲线 [a,b] 参数区间的弧长，8 点 Gauss–Legendre（mm，确定性高精度） */
export function cubicArcLength(
  e: Edge,
  verts: Record<string, Vec2>,
  a = 0,
  b = 1
): number {
  const mid = (a + b) / 2;
  const half = (b - a) / 2;
  let sum = 0;
  for (let k = 0; k < 8; k++) {
    const t = mid + half * GL8_T[k];
    const d = cubicDerivative(e, verts, t);
    sum += GL8_W[k] * Math.hypot(d.x, d.y);
  }
  return half * sum;
}

/** 边的弧长（mm）。Gauss–Legendre 积分，与屏幕 DPI/离散步长无关 */
export function edgeLength(e: Edge, verts: Record<string, Vec2>): number {
  return cubicArcLength(e, verts, 0, 1);
}

/**
 * 弧长分数 → 曲线参数 t（Gauss 弧长 + 二分）。
 * 稳定特征（记号）只存弧长分数；离散精度改变时重新调用本函数即可回到同一物理位置。
 */
export function arcFractionToT(e: Edge, verts: Record<string, Vec2>, f: number): number {
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  const total = cubicArcLength(e, verts, 0, 1);
  const target = total * f;
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (cubicArcLength(e, verts, 0, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function pointAtArcFraction(
  e: Edge,
  verts: Record<string, Vec2>,
  f: number
): Vec2 {
  return cubicPoint(e, verts, arcFractionToT(e, verts, f));
}

export function tangentAtArcFraction(
  e: Edge,
  verts: Record<string, Vec2>,
  f: number
): Vec2 {
  return cubicTangent(e, verts, arcFractionToT(e, verts, f));
}

/** 边按步长离散为点串（含两端）。步长改变只影响显示密度，不影响绑定 */
export function tessellateEdge(e: Edge, verts: Record<string, Vec2>, stepMm: number): Vec2[] {
  const l = edgeLength(e, verts);
  const n = Math.max(2, Math.ceil(l / stepMm) + 1);
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) pts.push(cubicPoint(e, verts, i / (n - 1)));
  return pts;
}

/**
 * 缝合轮廓离散环。边首尾相接（源模型环闭合的定义：edge.to === 下一条 edge.from）。
 * 顶点不重复写入，最后显式回到首边起点形成闭合环（闭合缺口恒为 0；
 * 拓扑断裂时 validate 另行报 NOT_CLOSED）。
 */
export function seamLoop(piece: Piece, stepMm: number): Vec2[] {
  const out: Vec2[] = [];
  for (const e of piece.edges) {
    if (!(e.from in piece.vertices) || !(e.to in piece.vertices)) continue; // 拓扑断裂：跳过
    const pts = tessellateEdge(e, piece.vertices, stepMm);
    pts.pop(); // 去掉末端，由下一条边起点给出
    out.push(...pts);
  }
  // 显式闭合：末点 → 首边起点。自交检测与面积计算都按闭合环处理。
  if (piece.edges.length && piece.edges[0].from in piece.vertices) {
    out.push({ ...piece.vertices[piece.edges[0].from] });
  }
  return out;
}

export function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function centroid(pts: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** 环闭合缺口：源模型拓扑闭合恒为 0；离散环首尾距离作为离散误差被单独记录 */
export function closureGap(loop: Vec2[]): number {
  if (loop.length < 2) return Infinity;
  return dist(loop[0], loop[loop.length - 1]);
}

/** 源拓扑闭合检查：每条边 to 必须等于下一条边 from */
export function topologicalClosure(piece: Piece): boolean {
  for (let i = 0; i < piece.edges.length; i++) {
    const cur = piece.edges[i];
    const next = piece.edges[(i + 1) % piece.edges.length];
    if (cur.to !== next.from) return false;
    if (!(cur.from in piece.vertices) || !(cur.to in piece.vertices)) return false;
  }
  return true;
}

function segmentsProperlyIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const r = sub(b, a);
  const s = sub(d, c);
  const rxs = cross(r, s);
  if (Math.abs(rxs) < 1e-12) return false;
  const qp = sub(c, a);
  const t = cross(qp, s) / rxs;
  const u = cross(qp, r) / rxs;
  return t > 1e-7 && t < 1 - 1e-7 && u > 1e-7 && u < 1 - 1e-7;
}

/**
 * 自交检测（O(n²)，环通常 < 2000 点；worker 侧再用 Clipper 做权威判定）。
 * 相邻边、回绕邻居跳过。
 */
export function countSelfIntersections(loop: Vec2[]): number {
  let count = 0;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === (i + 1) % n || i === (j + 1) % n) continue;
      const c = loop[j];
      const d = loop[(j + 1) % n];
      if (segmentsProperlyIntersect(a, b, c, d)) count++;
    }
  }
  return count;
}

export type PipResult = 'inside' | 'outside' | 'on';

export function pointInPolygon(p: Vec2, loop: Vec2[]): PipResult {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    // 点在边附近（0.01mm）判 on
    const ab = sub(b, a);
    const ap = sub(p, a);
    const abLen2 = dot(ab, ab);
    if (abLen2 > 0) {
      const t = Math.min(1, Math.max(0, dot(ap, ab) / abLen2));
      const proj = add(a, mul(ab, t));
      if (dist(proj, p) < 0.01) return 'on';
    }
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

/** 射线与环求交，返回沿射线方向（单位 dir）的最近交点参数；无交返回 null */
export function rayLoopNearest(origin: Vec2, dir: Vec2, loop: Vec2[]): number | null {
  const d = mul(dir, 1 / (len(dir) || 1));
  let best: number | null = null;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const e = sub(b, a);
    const den = cross(d, e);
    if (Math.abs(den) < 1e-12) continue;
    const diff = sub(a, origin);
    const t = cross(diff, e) / den;
    const u = cross(diff, d) / den;
    if (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9) {
      if (best === null || t < best) best = t;
    }
  }
  return best;
}

/** 剪线（开放折线）与旧记号的命中：折线任一段经过记号命中半径内 */
export function cutHitsMarks(
  cutPts: Vec2[],
  marks: { id: string; point: Vec2 }[],
  radius: number
): string[] {
  const hit = new Set<string>();
  for (const m of marks) {
    for (let i = 0; i < cutPts.length - 1; i++) {
      if (pointSegmentDistance(m.point, cutPts[i], cutPts[i + 1]) <= radius) {
        hit.add(m.id);
        break;
      }
    }
  }
  return [...hit];
}

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const abLen2 = dot(ab, ab);
  if (abLen2 === 0) return dist(p, a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / abLen2));
  return dist(p, add(a, mul(ab, t)));
}

/** 判定记号朝向是否指向裁片内侧：沿朝向射线先遇到轮廓则朝外，否则朝内 */
export function markPointsInward(
  origin: Vec2,
  direction: number,
  loop: Vec2[]
): boolean {
  const d = { x: Math.cos(direction), y: Math.sin(direction) };
  const forward = rayLoopNearest(origin, d, loop);
  const backward = rayLoopNearest(origin, mul(d, -1), loop);
  if (forward === null && backward === null) return false;
  if (forward === null) return true;
  if (backward === null) return false;
  return forward >= backward;
}

/** 求两条线（p1+t*d1, p2+s*d2）交点参数 t；平行返回 null */
export function lineLineT(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): number | null {
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-12) return null;
  return cross(sub(p2, p1), d2) / den;
}
