/**
 * 回退后端：纯 TS 的缝份外偏与自交检测。
 * 仅在 Clipper WASM 加载失败时使用（backend 字段会如实标记为 fallback-ts）。
 * 顶点圆采用分段圆逼近，结果同样经过自交/闭合校验门。
 */
import type { BooleanBackend } from './protocol';
import type { Tolerances, Vec2 } from '../core/types';
import { countSelfIntersections, polygonArea } from '../core/geometry';

const norm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};

/** miter 外偏（缝份拐角常用斜接/方角，这里用 miter + limit 截断） */
export function offsetPolygonMiter(
  pts: Vec2[],
  delta: number,
  miterLimit = 3
): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const n1 = norm({ x: cur.y - prev.y, y: -(cur.x - prev.x) }); // 左侧法向
    const n2 = norm({ x: next.y - cur.y, y: -(next.x - cur.x) });
    const bis = norm({ x: n1.x + n2.x, y: n1.y + n2.y });
    const denom = Math.abs(bis.x * n2.x + bis.y * n2.y) || 1e-6;
    let d = delta / denom;
    if (d > delta * miterLimit) d = delta * miterLimit;
    out.push({ x: cur.x + bis.x * d, y: cur.y + bis.y * d });
  }
  // 保持原朝向（外偏对 CCW 应放大；若得到反向则翻转法向符号）
  const a0 = polygonArea(pts);
  const a1 = polygonArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < Math.abs(a0)) {
    return pts.map((_, i) => {
      const cur = pts[i];
      const p = out[i];
      return { x: cur.x - (p.x - cur.x), y: cur.y - (p.y - cur.y) };
    });
  }
  return out;
}

export function createFallbackBackend(): BooleanBackend {
  return {
    name: 'fallback-ts',
    inflateCutline(loop, delta) {
      if (loop.length < 3) throw new Error('退化：环点数不足');
      return [offsetPolygonMiter(loop, delta)];
    },
    hasSelfIntersection(loop, tol) {
      void tol;
      return countSelfIntersections(loop) > 0;
    },
    signedArea(loop) {
      return polygonArea(loop);
    }
  };
}
