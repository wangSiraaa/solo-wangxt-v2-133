import type { CubicEdge, Edge, Vec } from '../model/types';
import { add, mul, sub } from './vec';

/** 三次贝塞尔按边存储方向（from->to）求值。 */
export function bezierPoint(e: CubicEdge, p0: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p0.x + b1 * e.c1.x + b2 * e.c2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * e.c1.y + b2 * e.c2.y + b3 * p3.y,
  };
}

export function bezierDerivative(e: CubicEdge, p0: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const q1 = sub(e.c1, p0);
  const q2 = sub(e.c2, e.c1);
  const q3 = sub(p3, e.c2);
  return {
    x: 3 * (u * u * q1.x + 2 * u * t * q2.x + t * t * q3.x),
    y: 3 * (u * u * q1.y + 2 * u * t * q2.y + t * t * q3.y),
  };
}

/**
 * 自适应细分（扁平度递归），返回严格递增参数与对应点。
 * 端点 t=0/1 由调用方在拼接时处理，这里给出内部细分参数。
 */
export function adaptiveFlattenParams(
  e: CubicEdge,
  p0: Vec,
  p3: Vec,
  tolerance: number,
): number[] {
  const ts: number[] = [];
  const tol2 = tolerance * tolerance;

  const flat = (a: Vec, b: Vec, c: Vec, d: Vec) => {
    // 控制点到弦的最大距离平方（经典 flatness 判定）。
    const d1 = distPointLineSq(b, a, d);
    const d2 = distPointLineSq(c, a, d);
    return Math.max(d1, d2) <= tol2;
  };

  const rec = (t0: number, t1: number, a: Vec, b: Vec, c: Vec, d: Vec, depth: number) => {
    if (depth > 18 || flat(a, b, c, d)) return;
    const t = (t0 + t1) / 2;
    const ab = mul(add(a, b), 0.5);
    const bc = mul(add(b, c), 0.5);
    const cd = mul(add(c, d), 0.5);
    const abc = mul(add(ab, bc), 0.5);
    const bcd = mul(add(bc, cd), 0.5);
    const abcd = mul(add(abc, bcd), 0.5);
    rec(t0, t, a, ab, abc, abcd, depth + 1);
    ts.push(t);
    rec(t, t1, abcd, bcd, cd, d, depth + 1);
  };

  rec(0, 1, p0, e.c1, e.c2, p3, 0);
  return ts;
}

function distPointLineSq(p: Vec, a: Vec, b: Vec): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-14) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    return dx * dx + dy * dy;
  }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  t = Math.min(1, Math.max(0, t));
  const qx = a.x + t * abx;
  const qy = a.y + t * aby;
  const dx = p.x - qx;
  const dy = p.y - qy;
  return dx * dx + dy * dy;
}

export function edgeLength(e: Edge, pFrom: Vec, pTo: Vec): number {
  if (e.curve === 'line') return Math.hypot(pTo.x - pFrom.x, pTo.y - pFrom.y);
  const ts = adaptiveFlattenParams(e, pFrom, pTo, 0.05);
  let total = 0;
  let prev = pFrom;
  for (const t of [...ts, 1]) {
    const cur = bezierPoint(e, pFrom, pTo, t);
    total += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
  }
  return total;
}

/** 在 t 处沿边【存储方向】的单位切向。 */
export function edgeTangentAt(e: Edge, pFrom: Vec, pTo: Vec, t: number): Vec {
  if (e.curve === 'line') {
    const d = sub(pTo, pFrom);
    const l = Math.hypot(d.x, d.y);
    return l < 1e-12 ? { x: 1, y: 0 } : { x: d.x / l, y: d.y / l };
  }
  const d = bezierDerivative(e, pFrom, pTo, t);
  const l = Math.hypot(d.x, d.y);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: d.x / l, y: d.y / l };
}

export function edgePointAt(e: Edge, pFrom: Vec, pTo: Vec, t: number): Vec {
  return e.curve === 'line'
    ? { x: pFrom.x + (pTo.x - pFrom.x) * t, y: pFrom.y + (pTo.y - pFrom.y) * t }
    : bezierPoint(e, pFrom, pTo, t);
}
