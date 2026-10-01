import type { Vec } from '../model/types';
import { cross, sub } from './vec';

export interface SubCubic {
  c1: Vec;
  c2: Vec;
}

/**
 * de Casteljau 在 t0 处精确切分三次贝塞尔。
 * 切分后两段与原曲线逐点相同，参数映射精确：
 *   t <= t0 -> t/t0；t >= t0 -> (t-t0)/(1-t0)。
 * 记号因此可以零漂移改绑，不依赖任何离散精度。
 */
export function splitCubic(p0: Vec, c1: Vec, c2: Vec, p3: Vec, t0: number): {
  first: { p0: Vec; c1: Vec; c2: Vec; p3: Vec };
  second: { p0: Vec; c1: Vec; c2: Vec; p3: Vec };
} {
  const q0 = lerp(p0, c1, t0);
  const q1 = lerp(c1, c2, t0);
  const q2 = lerp(c2, p3, t0);
  const r0 = lerp(q0, q1, t0);
  const r1 = lerp(q1, q2, t0);
  const s = lerp(r0, r1, t0);
  return {
    first: { p0, c1: q0, c2: r0, p3: s },
    second: { p0: s, c1: r1, c2: q2, p3 },
  };
}

function lerp(a: Vec, b: Vec, t: number): Vec {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export interface RayHit {
  t: number;
  point: Vec;
  /** 沿射线的距离。 */
  s: number;
}

/** 射线 o+s*d 与三次贝塞尔求交，返回最近正命中，精度 eps（mm）。 */
export function rayCubicIntersection(
  o: Vec,
  d: Vec,
  p0: Vec,
  c1: Vec,
  c2: Vec,
  p3: Vec,
  eps = 1e-5,
): RayHit | null {
  const hits: RayHit[] = [];

  const rec = (a: Vec, b: Vec, c: Vec, dd: Vec, tLo: number, tHi: number, depth: number) => {
    // 包围盒与射线的快速剔除（以点到射线距离 + 投影区间判定）
    if (!bboxMayHitRay(o, d, [a, b, c, dd])) return;
    if (depth > 40) {
      const t = (tLo + tHi) / 2;
      const mid = cubicAt(a, b, c, dd, t);
      const s = projection(mid, o, d);
      if (s > 1e-7) hits.push({ t, point: mid, s });
      return;
    }
    if (tHi - tLo < 1e-9) {
      const mid = cubicAt(a, b, c, dd, (tLo + tHi) / 2);
      const perp = Math.abs(cross(sub(mid, o), d));
      if (perp < eps) {
        const s = projection(mid, o, d);
        if (s > 1e-7) hits.push({ t: (tLo + tHi) / 2, point: mid, s });
      }
      return;
    }
    const mid = (tLo + tHi) / 2;
    const sp = splitCubic(a, b, c, dd, 0.5);
    rec(sp.first.p0, sp.first.c1, sp.first.c2, sp.first.p3, tLo, mid, depth + 1);
    rec(sp.second.p0, sp.second.c1, sp.second.c2, sp.second.p3, mid, tHi, depth + 1);
  };

  rec(p0, c1, c2, p3, 0, 1, 0);
  if (hits.length === 0) return null;
  hits.sort((h1, h2) => h1.s - h2.s);
  return hits[0];
}

function cubicAt(a: Vec, b: Vec, c: Vec, d: Vec, t: number): Vec {
  const u = 1 - t;
  return {
    x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
    y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y,
  };
}

function projection(p: Vec, o: Vec, d: Vec): number {
  const v = sub(p, o);
  const l2 = d.x * d.x + d.y * d.y;
  return (v.x * d.x + v.y * d.y) / l2;
}

function bboxMayHitRay(o: Vec, d: Vec, pts: Vec[]): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  // 凸性保证：控制点包围盒远离射线 => 不可能相交
  const sCorners = [
    projection({ x: minX, y: minY }, o, d),
    projection({ x: maxX, y: minY }, o, d),
    projection({ x: minX, y: maxY }, o, d),
    projection({ x: maxX, y: maxY }, o, d),
  ];
  if (Math.max(...sCorners) < -1e-6) return false;
  // 距离检查：包围盒任一角到射线过近或两侧分布才可能命中
  const sides = pts.map((p) => cross(sub(p, o), d));
  const allPos = sides.every((v) => v > 0);
  const allNeg = sides.every((v) => v < 0);
  if (allPos || allNeg) {
    // 严格同侧 => 无交（角点恰在射线上时数值由细分兜底）
    return Math.min(...sides.map(Math.abs)) < 1e-4;
  }
  return true;
}

/** 射线与线段求交。 */
export function rayLineIntersection(
  o: Vec,
  d: Vec,
  a: Vec,
  b: Vec,
): RayHit | null {
  const r = sub(b, a);
  const rxs = cross(d, r);
  if (Math.abs(rxs) < 1e-12) return null;
  const oa = sub(a, o);
  const s = cross(oa, r) / rxs;
  const t = cross(oa, d) / rxs;
  if (s > 1e-7 && t > 1e-9 && t < 1 - 1e-9) {
    return { t, point: { x: o.x + d.x * s, y: o.y + d.y * s }, s };
  }
  return null;
}
